import { endOfDay, endOfMonth, endOfWeek, endOfYear, parseISO, isValid, startOfDay, startOfMonth, startOfWeek, startOfYear, subDays, subMonths } from 'date-fns'
import { Decimal } from '#/genius/formula/decimal'
import type { CrmRecord, Field, Module } from '#/types'
import { findField, makeCtx, safeDate, valueOf, type Ctx } from '#/utils/records'
import type { DateRangeSpec, Preset } from './schema'

/** A configuration problem found while evaluating (unknown field, wrong type...). The runner records it on the config. */
export class EngineError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EngineError'
  }
}

export const slug = (s: string): string => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')

/** Everything an evaluation reads. Pure data, no store access. */
export interface EngineEnv {
  modules: Module[]
  /** every record of the workspace */
  records: CrmRecord[]
  ctx: Ctx
  now: Date
  /** memoised lookups, one env = one consistent snapshot */
  cache: Map<string, unknown>
}

export function makeEnv(modules: Module[], records: CrmRecord[], now = new Date(), ctx?: Ctx): EngineEnv {
  return { modules, records, ctx: ctx ?? makeCtx(modules, records, []), now, cache: new Map() }
}

/** Records that count: not archived and not in the trash. */
export const isLive = (r: CrmRecord): boolean => !r.deletedAt && !r.archived

export function liveRecordsOf(env: EngineEnv, moduleId: string): CrmRecord[] {
  const key = `live:${moduleId}`
  let list = env.cache.get(key) as CrmRecord[] | undefined
  if (!list) {
    list = env.records.filter((r) => r.moduleId === moduleId && isLive(r))
    env.cache.set(key, list)
  }
  return list
}

export function resolveModule(modules: Module[], ref: string | undefined): Module | undefined {
  if (!ref) return undefined
  const live = modules.filter((m) => !m.archived)
  const pool = live.length ? live : modules
  const key = slug(ref)
  return (
    pool.find((m) => m.id === ref) ??
    pool.find((m) => m.name === ref) ??
    pool.find((m) => slug(m.name) === key) ??
    (m_singular(pool, key) as Module | undefined) ??
    modules.find((m) => m.id === ref)
  )
}
const m_singular = (pool: Module[], key: string) => pool.find((m) => m.singularName && slug(m.singularName) === key)

export function resolveField(module: Module, ref: string | undefined): Field | undefined {
  if (!ref) return undefined
  const direct = findField(module, ref)
  if (direct) return direct
  const key = slug(ref)
  return module.fields.find((f) => slug(f.name) === key) ?? module.fields.find((f) => slug(f.label) === key)
}

export const isDateField = (f: Field | undefined): boolean => !!f && (f.type === 'date' || f.type === 'datetime' || f.id === '__createdAt' || f.id === '__updatedAt')
export const NUMERIC_TYPES = new Set(['number', 'currency', 'percentage', 'rating', 'formula'])
export const isNumberField = (f: Field | undefined): boolean => !!f && NUMERIC_TYPES.has(f.type)

export const isBlank = (v: unknown): boolean => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)

/** Parse a stored value as an exact decimal. Booleans and unparsable text are null; "$1,200.50" and "45%" are accepted. */
export function toDec(v: unknown): Decimal | null {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null
  if (v instanceof Decimal) return v
  if (typeof v === 'number') return Decimal.parse(v)
  if (typeof v === 'string') return Decimal.parse(v.replace(/[,\s$€£%]/g, ''))
  return null
}

export function toDate(v: unknown): Date | null {
  if (v instanceof Date) return isValid(v) ? v : null
  if (typeof v === 'string') {
    const d = safeDate(v) ?? null
    if (d) return d
    const p = parseISO(v)
    return isValid(p) ? p : null
  }
  return null
}

/** Value of a field on a record, with an overlay of not-yet-written changes on top (the engine's patches). */
export function readField(module: Module, record: CrmRecord, field: Field, env: EngineEnv, overlay?: Record<string, unknown>): unknown {
  if (overlay && Object.prototype.hasOwnProperty.call(overlay, field.id)) return overlay[field.id]
  return valueOf(module, record, field, env.ctx)
}

// ---- periods ---------------------------------------------------------------------------------------------------

export interface Window {
  from?: Date
  to?: Date
}

/** Legacy widget range codes map onto the readable names the config uses. */
export const LEGACY_RANGE: Record<string, Preset> = { '7d': 'last_7_days', '30d': 'last_30_days', '90d': 'last_90_days', year: 'this_year' }

/** Turn a preset, a { preset, from, to } object or a legacy widget code into a concrete time window (empty = no limit). */
export function resolveRange(range: DateRangeSpec | string | undefined, now: Date): Window {
  if (!range) return {}
  if (typeof range === 'object') {
    if (range.preset !== 'custom') return resolveRange(range.preset, now)
    const from = range.from ? toDate(range.from) : null
    const to = range.to ? toDate(range.to) : null
    return { from: from ? startOfDay(from) : undefined, to: to ? endOfDay(to) : undefined }
  }
  // legacy widget codes (7d/30d/90d/year) keep their historical meaning: a lower bound only
  if (LEGACY_RANGE[range]) return { from: resolveRange(LEGACY_RANGE[range], now).from }
  const r = range
  switch (r) {
    case 'today': return { from: startOfDay(now), to: endOfDay(now) }
    case 'this_week': return { from: startOfWeek(now, { weekStartsOn: 1 }), to: endOfWeek(now, { weekStartsOn: 1 }) }
    case 'this_month': return { from: startOfMonth(now), to: endOfMonth(now) }
    case 'last_month': { const m = subMonths(now, 1); return { from: startOfMonth(m), to: endOfMonth(m) } }
    case 'last_7_days': return { from: startOfDay(subDays(now, 6)), to: endOfDay(now) }
    case 'last_30_days': return { from: startOfDay(subDays(now, 29)), to: endOfDay(now) }
    case 'last_90_days': return { from: startOfDay(subDays(now, 89)), to: endOfDay(now) }
    case 'this_year': return { from: startOfYear(now), to: endOfYear(now) }
    default: return {}
  }
}

export const inWindow = (d: Date | null, w: Window): boolean => {
  if (!w.from && !w.to) return true
  if (!d) return false
  if (w.from && d < w.from) return false
  if (w.to && d > w.to) return false
  return true
}
