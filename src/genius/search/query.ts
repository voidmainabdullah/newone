import type { CrmRecord, Field, Module, User } from '#/types'
import { aggregate as aggregateRecords } from '#/utils/metrics'
import { displayValue, findField, makeCtx, recordTitle, valueOf, type Ctx } from '#/utils/records'
import { isEmpty } from '#/utils/fieldTypes'
import { canModule, canSeeRecord, fieldAccess, type Actor } from '../permissions/policy'

/**
 * Search over a workspace's own records. The model (or the user) fills in a typed QuerySpec; this file is the only thing that
 * executes it. There is no SQL and no free-form code: modules and fields are resolved against the real schema, unknown ones are
 * rejected, permissions are applied before anything is scored, and every number (counts, sums) is computed here, never by a model.
 */
export { QuerySpec, RelatedCondition, SearchFilter, SearchOp } from './spec'
import { QuerySpec, type SearchFilter } from './spec'

export interface SearchEnv {
  workspaceId: string
  modules: Module[]
  records: CrmRecord[]
  users: User[]
  actor: Actor
}

export interface SearchHit {
  moduleId: string
  moduleName: string
  recordId: string
  title: string
  score: number
  /** the field that matched the text, with a short excerpt */
  matched?: { field: string; excerpt: string }
  fields: { label: string; value: string }[]
  createdAt: string
}

export interface SearchResult {
  ok: boolean
  total: number
  hits: SearchHit[]
  moduleCounts: Record<string, number>
  aggregate?: { op: string; field?: string; values: { module: string; value: number }[] }
  /** what was actually applied, in words, so the user can check it */
  applied: string[]
  /** reasons the spec was rejected (unknown module/field, bad value). When present nothing was run. */
  errors: string[]
  tokens: string[]
}

export const SEARCH_MAX_LIMIT = 50
const TEXT_TYPES = new Set(['shortText', 'longText', 'email', 'phone', 'website', 'autoId', 'dropdown', 'radio', 'multiSelect', 'checkboxes', 'tags', 'address', 'relationship', 'formula', 'user'])
const ID_TYPES = new Set(['email', 'phone', 'autoId'])

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
const stem = (s: string) => norm(s).replace(/ies$/, 'y').replace(/s$/, '')
const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}@.+_-]+/u).map((w) => w.replace(/^[.\-_]+|[.\-_]+$/g, '')).filter((w) => w.length > 0)
const STOP = new Set(['the', 'a', 'an', 'of', 'for', 'and', 'or', 'in', 'on', 'with', 'to', 'all'])

function resolveModule(ref: string, mods: Module[]): Module | undefined {
  const k = stem(ref)
  return mods.find((m) => m.id === ref) ?? mods.find((m) => stem(m.name) === k || stem(m.singularName ?? '') === k || stem(m.id) === k)
}

function resolveField(ref: string, m: Module, actor: Actor): Field | undefined {
  const f = findField(m, ref) ?? m.fields.find((x) => norm(x.label) === norm(ref) || norm(x.name) === norm(ref))
  return f && fieldAccess(actor.role, f) !== 'hidden' ? f : undefined
}

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v])
const dateKey = (v: unknown): string | null => {
  if (typeof v !== 'string' && !(v instanceof Date)) return null
  const t = Date.parse(String(v))
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10)
}

function comparable(f: Field, raw: unknown, ctx: Ctx): { kind: 'num' | 'date' | 'text' | 'bool'; v: number | string | boolean | null; list: string[] } {
  if (raw === null || raw === undefined || raw === '') return { kind: 'text', v: null, list: [] }
  switch (f.type) {
    case 'number':
    case 'currency':
    case 'percentage':
    case 'rating': {
      const n = Number(raw)
      return { kind: 'num', v: Number.isFinite(n) ? n : null, list: [] }
    }
    case 'formula': {
      const n = typeof raw === 'number' ? raw : Number(raw)
      return Number.isFinite(n) && typeof raw !== 'boolean' && String(raw).trim() !== '' ? { kind: 'num', v: n, list: [] } : { kind: 'text', v: String(raw).toLowerCase(), list: [String(raw).toLowerCase()] }
    }
    case 'date':
    case 'datetime':
      return { kind: 'date', v: dateKey(raw), list: [] }
    case 'yesNo':
      return { kind: 'bool', v: Boolean(raw), list: [] }
    case 'dropdown':
    case 'radio':
    case 'multiSelect':
    case 'checkboxes': {
      const ids = asArray(raw).map(String)
      const list = ids.flatMap((id) => [id.toLowerCase(), String(f.options?.find((o) => o.id === id)?.label ?? id).toLowerCase()])
      return { kind: 'text', v: list[1] ?? list[0] ?? null, list }
    }
    case 'relationship': {
      const ids = asArray(raw).map(String)
      const list = ids.flatMap((id) => {
        const rec = ctx.records.get(id)
        const mod = rec ? ctx.modules.get(rec.moduleId) : undefined
        return [id.toLowerCase(), rec && mod ? recordTitle(mod, rec, ctx).toLowerCase() : id.toLowerCase()]
      })
      return { kind: 'text', v: list[1] ?? list[0] ?? null, list }
    }
    default: {
      const s = displayValue(f, raw, ctx).toLowerCase()
      return { kind: 'text', v: s, list: s ? [s] : [] }
    }
  }
}

/** Does `record` satisfy one filter on field `f`? Types decide the comparison: numbers as numbers, dates as dates, options by id or label. */
function matches(f: Field, raw: unknown, op: SearchFilter['op'], value: SearchFilter['value'], ctx: Ctx): boolean {
  if (op === 'empty') return isEmpty(raw) && raw !== false && raw !== 0
  if (op === 'not_empty') return !(isEmpty(raw) && raw !== false && raw !== 0)
  const c = comparable(f, raw, ctx)
  const want = (x: unknown): number | string | boolean | null => {
    if (c.kind === 'num') return typeof x === 'number' ? x : Number.isFinite(Number(x)) && String(x).trim() !== '' ? Number(x) : null
    if (c.kind === 'date') return dateKey(x)
    if (c.kind === 'bool') return typeof x === 'boolean' ? x : /^(true|yes|1)$/i.test(String(x))
    return x === null || x === undefined ? null : String(x).toLowerCase()
  }
  const hasOne = (w: unknown) => (c.kind === 'text' ? c.list.includes(String(w).toLowerCase()) || c.v === String(w).toLowerCase() : c.v === want(w))
  switch (op) {
    case 'eq':
      return hasOne(value as unknown)
    case 'neq':
      return !hasOne(value as unknown)
    case 'in':
      return asArray(value).some(hasOne)
    case 'contains':
      return c.kind === 'text' ? c.list.some((x) => x.includes(String(value ?? '').toLowerCase())) || String(c.v ?? '').includes(String(value ?? '').toLowerCase()) : false
    case 'not_contains':
      return c.kind === 'text' ? !(c.list.some((x) => x.includes(String(value ?? '').toLowerCase())) || String(c.v ?? '').includes(String(value ?? '').toLowerCase())) : true
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const w = want(value as unknown)
      if (c.v === null || w === null || c.kind === 'bool') return false
      const a = c.v as number | string
      const b = w as number | string
      return op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b
    }
  }
  return false
}

const describeFilter = (f: SearchFilter, label: string) => {
  const ops: Record<string, string> = { eq: '=', neq: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤', contains: 'contains', not_contains: 'does not contain', in: 'is one of', empty: 'is empty', not_empty: 'is not empty' }
  const v = f.op === 'empty' || f.op === 'not_empty' ? '' : ` ${Array.isArray(f.value) ? f.value.join(', ') : String(f.value ?? '')}`
  return `${label} ${ops[f.op]}${v}`.trim()
}

export function runSearch(specIn: QuerySpec, env: SearchEnv): SearchResult {
  const out: SearchResult = { ok: true, total: 0, hits: [], moduleCounts: {}, applied: [], errors: [], tokens: [] }
  const parsed = QuerySpec.safeParse(specIn)
  if (!parsed.success) return { ...out, ok: false, errors: [`The search is not valid: ${parsed.error.issues[0]?.path.join('.') ?? ''} ${parsed.error.issues[0]?.message ?? ''}`.trim()] }
  const spec = parsed.data
  const actor = env.actor
  const mine = env.modules.filter((m) => m.workspaceId === env.workspaceId && !m.archived && !m.system && canModule(actor.role, m, 'view'))
  const ctx = makeCtx(env.modules.filter((m) => m.workspaceId === env.workspaceId), env.records.filter((r) => r.workspaceId === env.workspaceId), env.users)

  // scope: only modules of this workspace the user may open
  let scope = mine
  if (spec.scope?.length) {
    scope = []
    for (const ref of spec.scope) {
      const m = resolveModule(ref, mine)
      if (m) scope.push(m)
      else out.errors.push(`Unknown or hidden module "${ref}".`)
    }
  }

  // filters: every field must exist (and be visible) in the schema
  type Resolved = { f: SearchFilter; byModule: Map<string, Field> }
  const filters: Resolved[] = []
  for (const f of spec.filters ?? []) {
    const byModule = new Map<string, Field>()
    const targets = f.module ? [resolveModule(f.module, scope)].filter((x): x is Module => !!x) : scope
    if (f.module && !targets.length) out.errors.push(`Unknown module "${f.module}" in a filter.`)
    for (const m of targets) {
      const fld = resolveField(f.field, m, actor)
      if (fld) byModule.set(m.id, fld)
    }
    if (!byModule.size && (!f.module || targets.length)) out.errors.push(`Unknown field "${f.field}" in ${f.module ? `"${f.module}"` : 'the searched modules'}.`)
    filters.push({ f, byModule })
  }
  type RelatedResolved = { module: Module; where: Resolved[]; exists: boolean }
  const related: RelatedResolved[] = []
  for (const rc of spec.related ?? []) {
    const rm = resolveModule(rc.module, mine)
    if (!rm) {
      out.errors.push(`Unknown or hidden related module "${rc.module}".`)
      continue
    }
    const where: Resolved[] = rc.where.map((f) => {
      const fld = resolveField(f.field, rm, actor)
      if (!fld) out.errors.push(`Unknown field "${f.field}" in "${rm.name}".`)
      return { f, byModule: new Map(fld ? [[rm.id, fld]] : []) }
    })
    related.push({ module: rm, where, exists: rc.exists !== false })
  }
  const sortFields = (spec.sort ?? []).map((s) => ({ s, byModule: new Map(scope.map((m) => [m.id, resolveField(s.field, m, actor)] as const).filter((x): x is readonly [string, Field] => !!x[1])) }))
  for (const s of sortFields) if (!s.byModule.size) out.errors.push(`Unknown sort field "${s.s.field}".`)
  const agg = spec.aggregate
  if (agg && agg.op !== 'count' && !agg.field) out.errors.push(`The ${agg.op} needs a field.`)
  if (out.errors.length) return { ...out, ok: false }

  const visibleRecords = (m: Module) => env.records.filter((r) => r.workspaceId === env.workspaceId && r.moduleId === m.id && !r.deletedAt && !r.archived && canSeeRecord(actor, m, r))
  const recordsIn = new Map(scope.map((m) => [m.id, visibleRecords(m)] as const))

  // relationship conditions: one hop, parent or child, via a real relationship field
  const passesRelated = (m: Module, r: CrmRecord): boolean =>
    related.every((rc) => {
      const matchesWhere = (rr: CrmRecord) => rc.where.every((w) => { const fld = w.byModule.get(rc.module.id); return !!fld && matches(fld, valueOf(rc.module, rr, fld, ctx), w.f.op, w.f.value, ctx) })
      const up = m.fields.filter((f) => f.relation?.moduleId === rc.module.id)
      const down = rc.module.fields.filter((f) => f.relation?.moduleId === m.id)
      let found = false
      for (const f of up) for (const id of asArray(r.data[f.id]).map(String)) { const p = ctx.records.get(id); if (p && !p.deletedAt && canSeeRecord(actor, rc.module, p) && matchesWhere(p)) found = true }
      if (!found && down.length) for (const c of env.records) { if (c.moduleId !== rc.module.id || c.deletedAt || c.workspaceId !== env.workspaceId || !canSeeRecord(actor, rc.module, c)) continue; if (down.some((f) => asArray(c.data[f.id]).map(String).includes(r.id)) && matchesWhere(c)) { found = true; break } }
      return rc.exists ? found : !found
    })

  const reachable = (m: Module) => related.every((rc) => m.fields.some((f) => f.relation?.moduleId === rc.module.id) || rc.module.fields.some((f) => f.relation?.moduleId === m.id))
  for (const rc of related) if (!scope.some((m) => m.fields.some((f) => f.relation?.moduleId === rc.module.id) || rc.module.fields.some((f) => f.relation?.moduleId === m.id))) out.errors.push(`"${rc.module.name}" is not linked to the searched modules.`)
  if (out.errors.length) return { ...out, ok: false }

  // candidates after hard filters (constraints, not ranking hints)
  type Cand = { m: Module; r: CrmRecord }
  let cands: Cand[] = []
  for (const m of scope) {
    if (filters.some((x) => !x.byModule.has(m.id))) continue
    if (related.length && !reachable(m)) continue
    for (const r of recordsIn.get(m.id) ?? []) {
      if (!filters.every((x) => { const fld = x.byModule.get(m.id)!; return matches(fld, valueOf(m, r, fld, ctx), x.f.op, x.f.value, ctx) })) continue
      if (related.length && !passesRelated(m, r)) continue
      cands.push({ m, r })
    }
  }
  for (const x of filters) out.applied.push(describeFilter(x.f, x.f.field))
  for (const rc of related) out.applied.push(`${rc.exists ? 'has' : 'has no'} ${rc.module.name} where ${rc.where.map((w) => describeFilter(w.f, w.f.field)).join(' and ')}`)
  if (spec.scope?.length) out.applied.unshift(`in ${scope.map((m) => m.name).join(', ')}`)

  // text: BM25 over weighted field text, exact identifiers first
  const scored = new Map<string, { score: number; matched?: { field: string; excerpt: string } }>()
  const text = (spec.text ?? '').trim()
  const tokens = words(text).filter((t) => !STOP.has(t))
  out.tokens = tokens
  if (text && tokens.length) {
    out.applied.push(`text "${text}"`)
    type Doc = { key: string; len: number; tf: Map<string, number>; fieldsText: { label: string; text: string; weight: number }[]; exact: number }
    const docs: Doc[] = cands.map(({ m, r }) => {
      const fieldsText: Doc['fieldsText'] = []
      let exact = 0
      const titleF = m.titleFieldId
      for (const f of m.fields) {
        if (fieldAccess(actor.role, f) === 'hidden' || !TEXT_TYPES.has(f.type)) continue
        const v = valueOf(m, r, f, ctx)
        if (v === null || v === undefined || v === '') continue
        const t = f.type === 'relationship' ? comparable(f, v, ctx).list.filter((_, i) => i % 2 === 1).join(' ') : displayValue(f, v, ctx)
        if (!t) continue
        const weight = f.id === titleF ? 3 : ID_TYPES.has(f.type) ? 2.5 : f.type === 'longText' ? 0.7 : 1
        fieldsText.push({ label: f.label, text: t, weight })
        const lower = t.toLowerCase()
        if (ID_TYPES.has(f.type) && tokens.some((tk) => lower === tk || lower.replace(/[\s()-]/g, '') === tk.replace(/[\s()-]/g, ''))) exact += 100
        else if (lower === text.toLowerCase()) exact += 60
        else if (tokens.some((tk) => lower.startsWith(tk))) exact += 6
      }
      const tf = new Map<string, number>()
      let len = 0
      for (const ft of fieldsText) for (const w of words(ft.text)) { tf.set(w, (tf.get(w) ?? 0) + ft.weight); len += ft.weight }
      return { key: `${m.id}:${r.id}`, len, tf, fieldsText, exact }
    })
    const N = docs.length || 1
    const avg = docs.reduce((a, d) => a + d.len, 0) / N || 1
    const df = new Map<string, number>()
    for (const tk of tokens) df.set(tk, docs.filter((d) => [...d.tf.keys()].some((w) => w === tk || w.startsWith(tk))).length)
    const k1 = 1.2
    const b = 0.75
    const keep: Cand[] = []
    docs.forEach((d, i) => {
      let s = d.exact
      let hit = d.exact > 0
      for (const tk of tokens) {
        let f = 0
        for (const [w, n] of d.tf) if (w === tk) f += n; else if (w.startsWith(tk) && tk.length >= 2) f += n * 0.6
        if (f > 0) {
          hit = true
          const idf = Math.log(1 + (N - (df.get(tk) ?? 0) + 0.5) / ((df.get(tk) ?? 0) + 0.5))
          s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / avg)))
        }
      }
      if (!hit) return
      // every word must appear somewhere (AND), so "red house" does not return all red things
      const allThere = tokens.every((tk) => [...d.tf.keys()].some((w) => w === tk || w.startsWith(tk)) || d.fieldsText.some((ft) => ft.text.toLowerCase().includes(tk)))
      if (!allThere) return
      let matched: { field: string; excerpt: string } | undefined
      let best = 0
      for (const ft of d.fieldsText) {
        const lower = ft.text.toLowerCase()
        const c = tokens.filter((tk) => lower.includes(tk)).length * ft.weight
        if (c > best) {
          best = c
          const at = Math.max(0, Math.min(...tokens.map((tk) => (lower.indexOf(tk) >= 0 ? lower.indexOf(tk) : 1e9))) - 20)
          matched = { field: ft.label, excerpt: `${at > 0 ? '…' : ''}${ft.text.slice(at, at + 90)}${ft.text.length > at + 90 ? '…' : ''}` }
        }
      }
      scored.set(d.key, { score: Math.round(s * 100) / 100, matched })
      keep.push(cands[i])
    })
    cands = keep
  }

  // order
  const cmp = (a: Cand, b: Cand): number => {
    for (const { s, byModule } of sortFields) {
      const fa = byModule.get(a.m.id)
      const fb = byModule.get(b.m.id)
      const va = fa ? valueOf(a.m, a.r, fa, ctx) : null
      const vb = fb ? valueOf(b.m, b.r, fb, ctx) : null
      const na = Number(va)
      const nb = Number(vb)
      const bothNum = va !== null && vb !== null && va !== '' && vb !== '' && Number.isFinite(na) && Number.isFinite(nb)
      const c = bothNum ? na - nb : String(va ?? '').localeCompare(String(vb ?? ''))
      if (c) return s.dir === 'asc' ? c : -c
    }
    const sa = scored.get(`${a.m.id}:${a.r.id}`)?.score ?? 0
    const sb = scored.get(`${b.m.id}:${b.r.id}`)?.score ?? 0
    return sb - sa || b.r.createdAt.localeCompare(a.r.createdAt)
  }
  cands.sort(cmp)

  out.total = cands.length
  for (const c of cands) out.moduleCounts[c.m.id] = (out.moduleCounts[c.m.id] ?? 0) + 1

  if (agg) {
    const byMod = new Map<string, Cand[]>()
    for (const c of cands) byMod.set(c.m.id, [...(byMod.get(c.m.id) ?? []), c])
    const values: { module: string; value: number }[] = []
    for (const [mid, list] of byMod) {
      const m = list[0].m
      const f = agg.field ? resolveField(agg.field, m, actor) : undefined
      if (agg.op !== 'count' && !f) continue
      values.push({ module: m.name, value: aggregateRecords(m, list.map((x) => x.r), agg.op, f?.id, ctx) })
      void mid
    }
    out.aggregate = { op: agg.op, field: agg.field, values }
  }

  const limit = Math.min(spec.limit ?? 25, SEARCH_MAX_LIMIT)
  const offset = spec.offset ?? 0
  out.hits = cands.slice(offset, offset + limit).map(({ m, r }) => {
    const s = scored.get(`${m.id}:${r.id}`)
    const fields: SearchHit['fields'] = []
    for (const f of m.fields) {
      if (fields.length >= 5) break
      if (fieldAccess(actor.role, f) === 'hidden' || ['file', 'image', 'document', 'signature'].includes(f.type)) continue
      const v = displayValue(f, valueOf(m, r, f, ctx), ctx)
      if (v) fields.push({ label: f.label, value: v.slice(0, 80) })
    }
    return { moduleId: m.id, moduleName: m.name, recordId: r.id, title: recordTitle(m, r, ctx), score: s?.score ?? 0, matched: s?.matched, fields, createdAt: r.createdAt }
  })
  return out
}
