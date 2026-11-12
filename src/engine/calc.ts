import { addDays, addMonths, addWeeks, addYears, differenceInCalendarDays, differenceInMonths, differenceInYears, format, startOfDay } from 'date-fns'
import { D, Decimal } from '#/genius/formula/decimal'
import type { CrmRecord, Field, Module } from '#/types'
import { uid } from '#/utils/id'
import { aggregateOver, type AggGroup, type AggQuery } from './aggregate'
import { EngineError, isDateField, isNumberField, liveRecordsOf, readField, resolveField, resolveModule, slug, toDate, toDec, type EngineEnv } from './resolve'
import { evalNode, fieldOrThrow, type RecordCtx } from './rules'
import { toIds } from '#/utils/records'
import type { CalcCore, CalculationBody, DateRangeSpec, Input, Related, WidgetFormat } from './schema'

/**
 * The calculation engine. No eval, no Function, no float arithmetic: every number is an exact Decimal
 * (src/genius/formula/decimal.ts).
 *
 * NULL / INVALID HANDLING (the contract the tests pin down)
 *  - A blank or non-numeric input is null. Arithmetic (add, subtract, multiply, divide, percentage, percent_of,
 *    compare, date_diff, date_add) returns null as soon as ANY input is null, unless that input has `default`:
 *    { "field": "discount", "default": 0 } reads a blank discount as 0.
 *  - Division by zero returns null (never Infinity, never an exception).
 *  - Aggregates over a list (sum, average, min, max, count on inputs, and everything over records) skip nulls.
 *    sum of nothing is 0, average / min / max of nothing is null, count of nothing is 0.
 *  - Dates: date_diff / date_add / compare need real dates; anything else is null.
 *  - Structural mistakes (unknown field, missing input, filters on a record-scope op) throw EngineError.
 */

export type Val = Decimal | Date | null

export interface CalcResult {
  /** record scope: the value for this record. aggregate scope: the overall value. */
  value: Val
  /** aggregate scope with groupBy / a time bucket: one entry per group, in display order */
  groups?: AggGroup[]
}

export interface CalcOptions {
  record?: CrmRecord
  /** field id -> value written but not stored yet */
  overlay?: Record<string, unknown>
}

interface Cx {
  module: Module
  env: EngineEnv
  record?: CrmRecord
  overlay?: Record<string, unknown>
  aggregate: boolean
  dateRange?: DateRangeSpec
  dateField?: string
}

const ZERO = Decimal.ZERO
const int = (n: number): Decimal => D(Math.trunc(n))

export const AGGREGATE_OPS = new Set(['sum', 'average', 'min', 'max', 'count', 'count_if', 'sum_if'])

/** record scope when an output field is named (or related records are aggregated), aggregate scope otherwise */
export function scopeOf(calc: Pick<CalculationBody, 'scope' | 'output_field' | 'groupBy' | 'dateRange'>): 'record' | 'aggregate' {
  if (calc.scope) return calc.scope
  const bucket = typeof calc.dateRange === 'object' ? calc.dateRange.bucket : undefined
  if (calc.groupBy || bucket) return 'aggregate'
  return calc.output_field ? 'record' : 'aggregate'
}

// ---- inputs ----------------------------------------------------------------------------------------------------

function literal(v: unknown, now: Date): Val {
  if (v === null || v === undefined) return null
  if (typeof v === 'boolean') return v ? D(1) : ZERO
  if (typeof v === 'number') return Decimal.parse(v)
  if (typeof v === 'string') {
    const k = v.trim().toLowerCase()
    if (k === 'today') return startOfDay(now)
    if (k === 'now') return now
    const n = toDec(v)
    if (n) return n
    return toDate(v)
  }
  return null
}

function fieldVal(cx: Cx, ref: string, dflt?: number | string): Val {
  if (cx.aggregate) throw new EngineError(`"${ref}" is a plain field input but this calculation runs over many records; wrap it in { "calc": { "operation": "sum", ... } }`)
  if (!cx.record) throw new EngineError(`"${ref}" needs a record`)
  const f = fieldOrThrow(cx.module, ref)
  const raw = readField(cx.module, cx.record, f, cx.env, cx.overlay)
  const v: Val = isDateField(f) ? toDate(raw) : toDec(raw)
  if (v !== null || dflt === undefined) return v
  return isDateField(f) && typeof dflt === 'string' ? literal(dflt, cx.env.now) : Decimal.parse(dflt as number | string)
}

function inputVal(i: Input, cx: Cx): Val {
  if ('field' in i) return fieldVal(cx, i.field, i.default)
  if ('value' in i) return literal(i.value, cx.env.now)
  if ('calc' in i) return evalCore(i.calc, cx)
  throw new EngineError('An input needs "field", "value" or "calc"')
}

const inputsOf = (core: CalcCore, cx: Cx, min: number, max = 99): Val[] => {
  const list = core.inputs ?? []
  if (list.length < min || list.length > max) throw new EngineError(`"${core.operation}" needs ${min === max ? min : `${min}${max < 99 ? `-${max}` : '+'}`} input(s), got ${list.length}`)
  return list.map((i) => inputVal(i, cx))
}

const decimals = (vals: Val[]): Decimal[] | null => (vals.every((v) => v instanceof Decimal) ? (vals as Decimal[]) : null)
const safeDiv = (a: Decimal, b: Decimal): Decimal | null => (b.isZero() ? null : a.div(b))

// ---- related records -------------------------------------------------------------------------------------------

function relatedRecords(cx: Cx, rel: Related): { module: Module; records: CrmRecord[] } {
  const relMod = resolveModule(cx.env.modules, rel.entity)
  if (!relMod) throw new EngineError(`Unknown related module "${rel.entity}"`)
  if (!cx.record) throw new EngineError('Related-record calculations run per record')
  const viaThere = resolveField(relMod, rel.via)
  if (viaThere?.type === 'relationship' && viaThere.relation?.moduleId === cx.module.id) {
    const key = `rev:${relMod.id}:${viaThere.id}`
    let index = cx.env.cache.get(key) as Map<string, CrmRecord[]> | undefined
    if (!index) {
      index = new Map()
      for (const r of liveRecordsOf(cx.env, relMod.id)) for (const id of toIds(r.data[viaThere.id])) (index.get(id) ?? index.set(id, []).get(id)!).push(r)
      cx.env.cache.set(key, index)
    }
    return { module: relMod, records: index.get(cx.record.id) ?? [] }
  }
  const viaHere = resolveField(cx.module, rel.via)
  if (viaHere?.type === 'relationship' && viaHere.relation?.moduleId === relMod.id) {
    const key = `byid:${relMod.id}`
    let byId = cx.env.cache.get(key) as Map<string, CrmRecord> | undefined
    if (!byId) {
      byId = new Map(liveRecordsOf(cx.env, relMod.id).map((r) => [r.id, r]))
      cx.env.cache.set(key, byId)
    }
    const raw = readField(cx.module, cx.record, viaHere, cx.env, cx.overlay)
    return { module: relMod, records: toIds(raw).map((id) => byId!.get(id)).filter((r): r is CrmRecord => !!r) }
  }
  throw new EngineError(`"${rel.via}" is not a relationship between "${cx.module.name}" and "${relMod.name}"`)
}

// ---- evaluation ------------------------------------------------------------------------------------------------

function aggregateOp(core: CalcCore, cx: Cx): Val {
  const op = core.operation
  const agg = op === 'count' || op === 'count_if' ? 'count' : op === 'sum' || op === 'sum_if' ? 'sum' : op === 'average' ? 'average' : op
  const first = core.inputs?.[0]
  if (first && !('field' in first)) throw new EngineError(`"${op}" over records takes a { "field" } input`)
  if ((op === 'count_if' || op === 'sum_if') && !core.filters?.length) throw new EngineError(`"${op}" needs "filters"`)
  if (op !== 'count' && op !== 'count_if' && !first) throw new EngineError(`"${op}" needs a field to aggregate`)
  const q: AggQuery = { entity: cx.module.id, agg: agg as AggQuery['agg'], field: first && 'field' in first ? first.field : undefined, filters: core.filters, dateRange: cx.dateRange, dateField: cx.dateField }
  if (core.related) {
    const rel = relatedRecords(cx, core.related)
    return aggregateOver(rel.module, rel.records, { ...q, entity: rel.module.id }, cx.env).value
  }
  if (!cx.aggregate) throw new EngineError(`"${op}" over records needs scope "aggregate" or a "related" module`)
  return aggregateOver(cx.module, liveRecordsOf(cx.env, cx.module.id), q, cx.env).value
}

function evalCore(core: CalcCore, cx: Cx): Val {
  const op = core.operation
  let out: Val
  switch (op) {
    case 'add':
    case 'subtract':
    case 'multiply': {
      const vals = decimals(inputsOf(core, cx, 1))
      if (!vals) return null
      out = vals.slice(1).reduce((a, b) => (op === 'add' ? a.add(b) : op === 'subtract' ? a.sub(b) : a.mul(b)), vals[0])
      break
    }
    case 'divide': {
      const vals = decimals(inputsOf(core, cx, 2))
      if (!vals) return null
      let acc: Decimal | null = vals[0]
      for (const v of vals.slice(1)) acc = acc && safeDiv(acc, v)
      out = acc
      break
    }
    case 'percentage': {
      const vals = decimals(inputsOf(core, cx, 2, 2))
      if (!vals) return null
      const q = safeDiv(vals[0], vals[1])
      out = q && q.mul(D(100))
      break
    }
    case 'percent_of': {
      // [percent, base] -> base * percent / 100
      const vals = decimals(inputsOf(core, cx, 2, 2))
      out = vals && vals[0].mul(vals[1]).div(D(100))
      break
    }
    case 'compare': {
      const [a, b] = inputsOf(core, cx, 2, 2)
      if (a instanceof Decimal && b instanceof Decimal) out = D(a.cmp(b))
      else if (a instanceof Date && b instanceof Date) out = D(a < b ? -1 : a > b ? 1 : 0)
      else out = null
      break
    }
    case 'date_diff': {
      const [from, to] = inputsOf(core, cx, 2, 2)
      if (!(from instanceof Date) || !(to instanceof Date)) return null
      const days = differenceInCalendarDays(to, from)
      switch (core.unit ?? 'days') {
        case 'days': out = int(days); break
        case 'weeks': out = int(days / 7); break
        case 'months': out = int(differenceInMonths(to, from)); break
        case 'years': out = int(differenceInYears(to, from)); break
      }
      break
    }
    case 'date_add': {
      const [date] = inputsOf(core, cx, 1, 1)
      if (!(date instanceof Date)) return null
      let amount: Decimal | null
      if (typeof core.amount === 'number') amount = Decimal.parse(core.amount)
      else if (core.amount && 'field' in core.amount) {
        const v = fieldVal(cx, core.amount.field)
        amount = v instanceof Decimal ? v : null
      } else throw new EngineError('"date_add" needs "amount"')
      if (!amount) return null
      const n = Math.trunc(amount.toNumber())
      switch (core.unit ?? 'days') {
        case 'days': out = addDays(date, n); break
        case 'weeks': out = addWeeks(date, n); break
        case 'months': out = addMonths(date, n); break
        case 'years': out = addYears(date, n); break
      }
      break
    }
    case 'if': {
      if (!core.condition) throw new EngineError('"if" needs a "condition"')
      if (cx.aggregate || !cx.record) throw new EngineError('"if" runs per record')
      const rc: RecordCtx = { module: cx.module, record: cx.record, env: cx.env, overlay: cx.overlay }
      const branch = evalNode(core.condition, rc) ? core.then : core.else
      out = branch ? inputVal(branch, cx) : null
      break
    }
    default: {
      // sum / average / min / max / count / count_if / sum_if
      if (core.related || cx.aggregate || op === 'count_if' || op === 'sum_if') return roundVal(aggregateOp(core, cx), core.precision)
      // plain list aggregate over this record's inputs, nulls skipped
      const nums = inputsOf(core, cx, 1).filter((v): v is Decimal => v instanceof Decimal)
      if (op === 'count') out = int(nums.length)
      else if (op === 'sum') out = nums.reduce((a, b) => a.add(b), ZERO)
      else if (!nums.length) out = null
      else if (op === 'average') out = nums.reduce((a, b) => a.add(b), ZERO).div(int(nums.length), 12)
      else out = nums.reduce((a, b) => ((op === 'min' ? b.cmp(a) < 0 : b.cmp(a) > 0) ? b : a))
    }
  }
  return roundVal(out, core.precision)
}

function roundVal(v: Val, precision?: number): Val {
  return v instanceof Decimal && precision !== undefined ? v.round(precision).normalize() : v
}

/** Evaluate a calculation. Pure: nothing is written (see runtime.ts). */
export function runCalculation(calc: CalculationBody, env: EngineEnv, opts: CalcOptions = {}): CalcResult {
  const module = resolveModule(env.modules, calc.entity)
  if (!module) throw new EngineError(`Unknown module "${calc.entity}"`)
  const scope = scopeOf(calc)
  const range = calc.dateRange
  const cx: Cx = { module, env, record: opts.record, overlay: opts.overlay, aggregate: scope === 'aggregate', dateRange: range, dateField: typeof range === 'object' ? range.field : undefined }
  if (scope === 'record' && !opts.record) throw new EngineError(`"${calc.name}" runs per record`)
  const bucket = typeof range === 'object' ? range.bucket : undefined
  if (scope === 'aggregate' && (calc.groupBy || bucket)) {
    if (!AGGREGATE_OPS.has(calc.operation)) throw new EngineError('groupBy and period buckets need an aggregate operation (sum, average, min, max, count, count_if, sum_if)')
    const first = calc.inputs?.[0]
    const op = calc.operation
    const res = aggregateOver(
      module,
      liveRecordsOf(env, module.id),
      { entity: module.id, agg: op === 'count' || op === 'count_if' ? 'count' : op === 'sum' || op === 'sum_if' ? 'sum' : (op as 'average' | 'min' | 'max'), field: first && 'field' in first ? first.field : undefined, filters: calc.filters, groupBy: calc.groupBy, dateRange: range, dateField: cx.dateField, bucket },
      env,
    )
    return { value: roundVal(res.value, calc.precision), groups: res.groups }
  }
  return { value: evalCore(calc, cx) }
}

// ---- storing results -------------------------------------------------------------------------------------------

export const defaultPrecision = (type: string): number => (type === 'currency' || type === 'percentage' ? 2 : 6)

/** What the output field stores for a value: a rounded number, an ISO date, or null. */
export function toStored(v: Val, calc: Pick<CalculationBody, 'output' | 'precision'>, field?: Field): number | string | null {
  if (v === null) return null
  if (v instanceof Date) return format(v, 'yyyy-MM-dd')
  const p = calc.output?.precision ?? calc.precision ?? field?.precision ?? defaultPrecision(calc.output?.type ?? field?.type ?? 'number')
  return v.round(p).normalize().toNumber()
}

/** equality used to skip writes: numbers compare as decimals, null equals undefined and "" */
export function sameValue(a: unknown, b: unknown): boolean {
  const ba = a === null || a === undefined || a === ''
  const bb = b === null || b === undefined || b === ''
  if (ba || bb) return ba && bb
  if (typeof a === 'number' && typeof b === 'number') return a === b
  const da = typeof a === 'string' ? null : toDec(a)
  const db = typeof b === 'string' ? null : toDec(b)
  if (da && db) return da.eq(db)
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameValue(x, b[i]))
  return a === b
}

const OUTPUT_TYPE: Record<string, Field['type']> = { number: 'number', currency: 'currency', percentage: 'percentage', date: 'date' }

/** The type a new output field gets: percentages for percentage ops, dates for date_add, currency when money goes in. */
export function inferOutputType(calc: CalculationBody, module: Module, env?: EngineEnv): { type: Field['type']; currency?: string } {
  if (calc.output?.type) return { type: OUTPUT_TYPE[calc.output.type], currency: calc.output.currency }
  const op = calc.operation
  if (op === 'percentage' || op === 'percent_of') return { type: 'percentage' }
  if (op === 'date_add') return { type: 'date' }
  if (op === 'count' || op === 'count_if' || op === 'compare' || op === 'date_diff') return { type: 'number' }
  const fields: Field[] = []
  const walk = (c: CalcCore) => {
    for (const i of c.inputs ?? []) {
      if ('field' in i) {
        const m = c.related && env ? resolveModule(env.modules, c.related.entity) : module
        const f = m && resolveField(m, i.field)
        if (f) fields.push(f)
      } else if ('calc' in i) walk(i.calc)
    }
    for (const b of [c.then, c.else]) if (b && 'calc' in b) walk(b.calc)
    for (const b of [c.then, c.else]) if (b && 'field' in b) { const f = resolveField(module, b.field); if (f) fields.push(f) }
  }
  walk(calc)
  const money = fields.find((f) => f.type === 'currency')
  if (!money) return { type: 'number' }
  // money divided by money is a ratio; money divided by a plain number is still money
  if (op === 'divide' && !(fields[0]?.type === 'currency' && fields.filter((f) => f.type === 'currency').length === 1)) return { type: 'number' }
  return { type: 'currency', currency: money.currency }
}

/**
 * Find the calculation's output field, or describe the one to create:
 * stored (never a formula), flagged `calculated` and read-only, so forms and inline controls never offer it for editing.
 */
export function outputFieldFor(calc: CalculationBody, module: Module, env?: EngineEnv): { field: Field; created: boolean } {
  if (!calc.output_field) throw new EngineError(`"${calc.name}" has no output_field`)
  const existing = resolveField(module, calc.output_field)
  if (existing) return { field: existing, created: false }
  const { type, currency } = inferOutputType(calc, module, env)
  const name = slug(calc.output_field)
  const field: Field = {
    id: uid('fld'),
    name,
    label: calc.output?.label ?? calc.output_field.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    type,
    width: 'half',
    order: module.fields.length,
    readOnly: true,
    calculated: true,
    precision: calc.output?.precision ?? calc.precision ?? defaultPrecision(type),
    ...(type === 'currency' ? { currency: currency ?? 'USD' } : {}),
    description: `Calculated by "${calc.name}"`,
  }
  return { field, created: true }
}

/** Can this calculation write into the field? Formulas and relationship fields are not storage. */
export const isWritableOutput = (f: Field): boolean => isNumberField(f) ? f.type !== 'formula' : f.type === 'date' || f.type === 'datetime'

// ---- formatting ------------------------------------------------------------------------------------------------

/** Format a value for display with the field's / widget's settings. Percent values are already 0-100 ("45" -> "45%"). */
export function formatValue(v: number | Decimal | null | undefined, fmt: WidgetFormat | { kind: 'number' | 'currency' | 'percent'; precision?: number; currency?: string } = { kind: 'number' }): string {
  if (v === null || v === undefined) return '—'
  const d = v instanceof Decimal ? v : Decimal.parse(v)
  if (!d) return '—'
  const places = fmt.precision ?? (fmt.kind === 'number' ? undefined : 2)
  const n = (places === undefined ? d : d.round(places)).toNumber()
  if (!Number.isFinite(n)) return '—'
  const opts: Intl.NumberFormatOptions = places === undefined ? { maximumFractionDigits: 6 } : { minimumFractionDigits: places, maximumFractionDigits: places }
  try {
    if (fmt.kind === 'currency') return new Intl.NumberFormat('en-US', { style: 'currency', currency: fmt.currency || 'USD', ...opts }).format(n)
    if (fmt.kind === 'percent') return `${new Intl.NumberFormat('en-US', opts).format(n)}%`
    return new Intl.NumberFormat('en-US', opts).format(n)
  } catch {
    return String(n)
  }
}

/** The display format that goes with an output field. */
export function formatOfField(f: Pick<Field, 'type' | 'currency' | 'precision'>): WidgetFormat {
  if (f.type === 'currency') return { kind: 'currency', currency: f.currency, precision: f.precision }
  if (f.type === 'percentage') return { kind: 'percent', precision: f.precision }
  return { kind: 'number', precision: f.precision }
}