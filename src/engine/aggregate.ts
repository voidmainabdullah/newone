import { endOfWeek, format, startOfWeek } from 'date-fns'
import { Decimal } from '#/genius/formula/decimal'
import type { CrmRecord, Field, Filter, Module } from '#/types'
import { displayValue, matchesFilter, toIds } from '#/utils/records'
import { EngineError, inWindow, isBlank, isDateField, liveRecordsOf, readField, resolveField, resolveModule, resolveRange, toDate, toDec, type EngineEnv } from './resolve'
import { evalConditions } from './rules'
import type { Aggregation, Bucket, ConditionNode, DateRangeSpec } from './schema'

/**
 * The one aggregation function behind calculations (aggregate scope, related records) and dashboard widgets.
 * One pass over the records: filters, date window, grouping and the aggregate are all decided inside the loop.
 * Sums use exact decimals. Results are memoised per (records array, modules array, query).
 */

export interface AggQuery {
  /** module id or API name */
  entity: string
  agg: Aggregation
  /** field to aggregate (count without a field counts records) */
  field?: string
  /** engine conditions (any operator, nested groups) */
  filters?: ConditionNode[]
  /** the legacy dashboard filter format, applied together with `filters` */
  legacyFilters?: Filter[]
  groupBy?: string
  /** the date field used for the window and for date grouping (default: created date) */
  dateField?: string
  dateRange?: DateRangeSpec | string
  /** group by time: day, week, month or year of `dateField` */
  bucket?: Bucket
  /** group list size (default 50, widgets use 24) */
  limit?: number
  /** use these records instead of every live record of the module (related-record and permission-scoped queries) */
  records?: CrmRecord[]
}

export interface AggGroup {
  key: string
  label: string
  color?: string
  value: Decimal | null
  count: number
}

export interface AggResult {
  module?: Module
  /** the aggregate over all matching records; sum of nothing is 0, average/min/max of nothing is null */
  value: Decimal | null
  /** matching records */
  count: number
  groups: AggGroup[]
}

class Acc {
  n = 0
  nonNull = 0
  sum: Decimal = Decimal.ZERO
  min: Decimal | null = null
  max: Decimal | null = null
  add(d: Decimal | null) {
    this.n++
    if (!d) return
    this.nonNull++
    this.sum = this.sum.add(d)
    if (!this.min || d.cmp(this.min) < 0) this.min = d
    if (!this.max || d.cmp(this.max) > 0) this.max = d
  }
  result(agg: Aggregation, hasField: boolean): Decimal | null {
    switch (agg) {
      case 'count': return Decimal.of(BigInt(hasField ? this.nonNull : this.n))
      case 'sum': return this.sum
      case 'average': return this.nonNull ? this.sum.div(Decimal.of(BigInt(this.nonNull)), 12) : null
      case 'min': return this.min
      case 'max': return this.max
    }
  }
}

export const bucketKey = (d: Date, bucket: Bucket): { key: string; label: string } => {
  switch (bucket) {
    case 'day': return { key: format(d, 'yyyy-MM-dd'), label: format(d, 'MMM d') }
    case 'week': { const s = startOfWeek(d, { weekStartsOn: 1 }); return { key: format(s, 'yyyy-MM-dd'), label: `${format(s, 'MMM d')} – ${format(endOfWeek(d, { weekStartsOn: 1 }), 'MMM d')}` } }
    case 'year': return { key: format(d, 'yyyy'), label: format(d, 'yyyy') }
    default: return { key: format(d, 'yyyy-MM'), label: format(d, 'MMM yyyy') }
  }
}

interface GroupKey {
  key: string
  label: string
  color?: string
}

function groupKeysFor(field: Field, value: unknown, env: EngineEnv, bucket: Bucket | undefined): GroupKey[] {
  if (isDateField(field)) {
    const d = toDate(value)
    return d ? [bucketKey(d, bucket ?? 'month')] : [{ key: '', label: '(no date)' }]
  }
  if (isBlank(value)) return [{ key: '', label: '(none)' }]
  const ids = Array.isArray(value) ? value : field.type === 'relationship' || field.type === 'user' ? toIds(value) : [value]
  return ids.map((v) => {
    const opt = field.options?.find((o) => o.id === String(v))
    if (opt) return { key: opt.id, label: opt.label, color: opt.color }
    if (field.type === 'yesNo') return { key: v ? 'true' : 'false', label: v ? 'Yes' : 'No' }
    return { key: String(v), label: displayValue(field, v, env.ctx) || String(v) }
  })
}

/** Aggregate pre-selected records of `module`. `runAggregate` is the entry point that selects them and memoises. */
export function aggregateOver(module: Module, records: CrmRecord[], q: AggQuery, env: EngineEnv): AggResult {
  const field = q.field ? resolveField(module, q.field) : undefined
  if (q.field && !field) throw new EngineError(`Unknown field "${q.field}" in "${module.name}"`)
  const groupField = q.groupBy ? resolveField(module, q.groupBy) : undefined
  if (q.groupBy && !groupField) throw new EngineError(`Unknown field "${q.groupBy}" in "${module.name}"`)
  const range = q.dateRange
  const preset = typeof range === 'object' ? range : undefined
  const bucket = q.bucket ?? preset?.bucket
  const dateRef = q.dateField ?? preset?.field ?? '__createdAt'
  const dateField = resolveField(module, dateRef)
  if ((range && range !== 'all') || bucket) {
    if (!dateField || !isDateField(dateField)) throw new EngineError(`"${dateRef}" is not a date field of "${module.name}"`)
  }
  const win = resolveRange(range, env.now)
  const windowed = !!(win.from || win.to)
  // time series: no explicit groupBy but a bucket => group by the date field
  const gField = groupField ?? (bucket ? dateField : undefined)
  const nodes = q.filters?.length ? q.filters : undefined
  const legacy = q.legacyFilters?.filter((f) => f.fieldId)

  const total = new Acc()
  const groups = new Map<string, { k: GroupKey; acc: Acc }>()
  const rc = { module, env } as { module: Module; env: EngineEnv; record: CrmRecord }
  for (const r of records) {
    if (windowed && !inWindow(dateField ? toDate(readField(module, r, dateField, env)) : null, win)) continue
    if (legacy?.length && !legacy.every((f) => matchesFilter(module, r, f, env.ctx))) continue
    if (nodes) {
      rc.record = r
      if (!evalConditions(nodes, 'AND', rc)) continue
    }
    const n = field ? toDec(readField(module, r, field, env)) : null
    total.add(n)
    if (gField) {
      for (const k of groupKeysFor(gField, readField(module, r, gField, env), env, bucket)) {
        let g = groups.get(k.key)
        if (!g) groups.set(k.key, (g = { k, acc: new Acc() }))
        g.acc.add(n)
      }
    }
  }
  const hasField = !!field
  let out: AggGroup[] = [...groups.values()].map(({ k, acc }) => ({ key: k.key, label: k.label, color: k.color, value: acc.result(q.agg, hasField), count: acc.n }))
  if (gField) {
    if (isDateField(gField)) out.sort((a, b) => a.key.localeCompare(b.key))
    else if (gField.options?.length) {
      const order = new Map(gField.options.map((o, i) => [o.id, i]))
      out.sort((a, b) => (order.get(a.key) ?? 999) - (order.get(b.key) ?? 999))
    } else out.sort((a, b) => (b.value && a.value ? b.value.cmp(a.value) : 0) || a.label.localeCompare(b.label))
    out = out.slice(0, q.limit ?? 50)
  }
  return { module, value: total.result(q.agg, hasField), count: total.n, groups: out }
}

// ---- memoised entry point --------------------------------------------------------------------------------------

interface CacheBucket {
  modules: Module[]
  entries: Map<string, AggResult>
}
const memo = new WeakMap<object, CacheBucket>()
const MAX_ENTRIES = 300

export function runAggregate(env: EngineEnv, q: AggQuery): AggResult {
  const module = resolveModule(env.modules, q.entity)
  if (!module) throw new EngineError(`Unknown module "${q.entity}"`)
  const source = q.records ?? env.records
  let bucket = memo.get(source)
  if (!bucket || bucket.modules !== env.modules) memo.set(source, (bucket = { modules: env.modules, entries: new Map() }))
  // relative ranges ("this month") depend on the clock: refresh the entry once a minute
  const clock = q.dateRange && q.dateRange !== 'all' ? Math.floor(env.now.getTime() / 60000) : 0
  const { records: _records, ...rest } = q
  const key = JSON.stringify([module.id, rest, clock])
  const hit = bucket.entries.get(key)
  if (hit) return hit
  const records = q.records ? q.records.filter((r) => r.moduleId === module.id) : liveRecordsOf(env, module.id)
  const res = aggregateOver(module, records, q, env)
  if (bucket.entries.size >= MAX_ENTRIES) bucket.entries.clear()
  bucket.entries.set(key, res)
  return res
}

/** Numeric value of a result (null stays null). Display code formats with calc.ts `formatValue`. */
export const numberOf = (d: Decimal | null): number | null => (d ? d.toNumber() : null)
