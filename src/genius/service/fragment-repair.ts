import { parseJsonLoose } from '../ai/json-utils'
import type { Issue } from '../validation/issues'

/**
 * Fragment repair: when validation rejects only some parts of a large design, send the model ONLY those parts (never the
 * whole CRM, the conversation or the context) together with their exact errors, and splice the corrected parts back in.
 * Pure functions, no model and no store: the planner decides what to send, the applier decides what may come back.
 *
 * Guarantees: a returned fragment is accepted only if its path was requested, it parses to the same kind of value
 * (object stays object), and its `id` did not change (ids are stable, never renamed by a repair). Everything else in the
 * design is byte-for-byte untouched.
 */
export const MAX_FRAGMENTS = 10
export const MAX_FRAGMENT_CHARS = 24_000

export interface FragmentRequest {
  path: string
  value: unknown
  errors: { code: string; path: string; message: string; allowed?: string[]; received?: unknown; suggested?: unknown; repair: string }[]
}

const isIndex = (s: string) => /^\d+$/.test(s)

export function getAt(root: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), root)
}

export function setAt(root: unknown, path: string, value: unknown): boolean {
  const segs = path.split('.')
  const last = segs.pop()!
  const parent = segs.length ? getAt(root, segs.join('.')) : root
  if (!parent || typeof parent !== 'object') return false
  ;(parent as Record<string, unknown>)[last] = value
  return true
}

/** The nearest enclosing array item of an error path (`dashboards.0.components.0` for `...components.0.dateRange`), else its top-level key. */
export function fragmentRootOf(path: string): string | null {
  if (!path || path === '(root)') return null
  const segs = path.split('.')
  for (let i = segs.length; i >= 1; i--) if (isIndex(segs[i - 1])) return segs.slice(0, i).join('.')
  return segs.length > 1 ? segs[0] : null
}

export type FragmentPlan = { ok: true; fragments: FragmentRequest[] } | { ok: false; reason: string }

export function planFragments(raw: unknown, errors: Issue[]): FragmentPlan {
  const schemaErrors = errors.filter((e) => e.stage === 'schema')
  if (!schemaErrors.length || schemaErrors.length !== errors.length) return { ok: false, reason: 'not every problem is a schema problem' }
  const roots = new Map<string, Issue[]>()
  for (const e of schemaErrors) {
    const root = fragmentRootOf(e.path)
    if (!root || getAt(raw, root) === undefined) return { ok: false, reason: `no fixable fragment for ${e.path}` }
    roots.set(root, [...(roots.get(root) ?? []), e])
  }
  // when one root contains another, repair the outer one only
  const all = [...roots.keys()]
  const outer = all.filter((r) => !all.some((o) => o !== r && r.startsWith(`${o}.`)))
  const fragments: FragmentRequest[] = outer.map((path) => ({
    path,
    value: getAt(raw, path),
    errors: [...roots.entries()].filter(([r]) => r === path || r.startsWith(`${path}.`)).flatMap(([, v]) => v).slice(0, 12).map((e) => ({ code: e.code, path: e.path, message: e.message.slice(0, 200), allowed: e.allowed, received: e.received, suggested: e.suggested, repair: e.repair.slice(0, 160) })),
  }))
  if (fragments.length > MAX_FRAGMENTS) return { ok: false, reason: 'too many separate fragments' }
  if (JSON.stringify(fragments).length > MAX_FRAGMENT_CHARS) return { ok: false, reason: 'fragments are too large to send alone' }
  return { ok: true, fragments }
}

export interface ApplyFragmentsResult {
  next: unknown
  applied: string[]
  rejected: { path: string; why: string }[]
}

export function applyFragments(raw: unknown, requested: FragmentRequest[], returned: { path: string; valueJson: string }[]): ApplyFragmentsResult {
  const next = structuredClone(raw)
  const applied: string[] = []
  const rejected: ApplyFragmentsResult['rejected'] = []
  const want = new Map(requested.map((f) => [f.path, f]))
  for (const r of returned) {
    const req = want.get(r.path)
    if (!req) {
      rejected.push({ path: r.path, why: 'not a requested fragment' })
      continue
    }
    const value = parseJsonLoose(r.valueJson) ?? (() => { try { return JSON.parse(r.valueJson) } catch { return undefined } })()
    if (value === undefined || value === null || typeof value !== typeof req.value || Array.isArray(value) !== Array.isArray(req.value)) {
      rejected.push({ path: r.path, why: 'not valid JSON of the same shape' })
      continue
    }
    const before = req.value as { id?: unknown }
    const after = value as { id?: unknown }
    if (typeof before?.id === 'string' && before.id !== after?.id) {
      rejected.push({ path: r.path, why: 'the repair changed the id' })
      continue
    }
    if (setAt(next, r.path, value)) applied.push(r.path)
    else rejected.push({ path: r.path, why: 'path no longer exists' })
  }
  return { next, applied, rejected }
}
