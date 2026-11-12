import { nowIso, uid } from '#/utils/id'
import { scopeOf } from './calc'
import { META_KEYS, SCHEMAS, typeToKind, type AnyBody, type AnyItem, type BodyOf, type ConfigKind, type ItemOf } from './schema'

/** Building blocks shared by the store, the validator and the runtime: ids, defaults, version bumps, parsing. */

export interface Issue {
  path: string
  message: string
}

const PREFIX: Record<ConfigKind, string> = {
  calculations: 'calc',
  conditional_rules: 'rule',
  custom_fields: 'cfld',
  automations: 'auto',
  dashboards: 'dash',
  dashboard_widgets: 'dwid',
  filters: 'flt',
  permissions: 'perm',
}

/** Fill the optional parts of a body with their documented defaults. */
export function withDefaults<K extends ConfigKind>(kind: K, body: BodyOf[K]): BodyOf[K] {
  const b = { ...(body as object) } as Record<string, unknown>
  switch (kind) {
    case 'calculations': {
      const c = body as BodyOf['calculations']
      b.scope = c.scope ?? scopeOf(c)
      b.trigger = c.trigger ?? 'on_record_change'
      b.auto_update = c.auto_update ?? true
      break
    }
    case 'conditional_rules':
      b.trigger = (body as BodyOf['conditional_rules']).trigger ?? 'on_record_change'
      b.mode = (body as BodyOf['conditional_rules']).mode ?? 'first_match'
      break
    case 'dashboards':
      b.scope = (body as BodyOf['dashboards']).scope ?? 'workspace'
      break
  }
  return b as unknown as BodyOf[K]
}

export interface MetaInput {
  workspaceId: string
  ownerId: string
  id?: string
  now?: string
}

export function makeItem<K extends ConfigKind>(kind: K, body: BodyOf[K], meta: MetaInput): ItemOf[K] {
  const t = meta.now ?? nowIso()
  const b = withDefaults(kind, body)
  return { ...b, id: meta.id ?? uid(PREFIX[kind]), version: 1, enabled: (body as { enabled?: boolean }).enabled ?? true, createdAt: t, updatedAt: t, ownerId: meta.ownerId, workspaceId: meta.workspaceId } as unknown as ItemOf[K]
}

/** Every edit bumps the version and the timestamp. The id, owner, workspace and creation time never change. */
export function bumpItem<K extends ConfigKind>(kind: K, item: ItemOf[K], patch: Partial<BodyOf[K]>, now = nowIso()): ItemOf[K] {
  const next = withDefaults(kind, { ...stripMeta(item), ...patch } as BodyOf[K])
  return { ...next, id: item.id, version: item.version + 1, enabled: (patch as { enabled?: boolean }).enabled ?? item.enabled, createdAt: item.createdAt, updatedAt: now, ownerId: item.ownerId, workspaceId: item.workspaceId } as unknown as ItemOf[K]
}

/** Replace the whole body (an edit made in the JSON editor): keys that are gone from the new body are gone from the item. */
export function replaceItem<K extends ConfigKind>(kind: K, item: ItemOf[K], body: BodyOf[K], now = nowIso()): ItemOf[K] {
  const next = withDefaults(kind, body)
  return { ...next, id: item.id, version: item.version + 1, enabled: (body as { enabled?: boolean }).enabled ?? item.enabled, createdAt: item.createdAt, updatedAt: now, ownerId: item.ownerId, workspaceId: item.workspaceId } as unknown as ItemOf[K]
}

export function stripMeta<T extends object>(item: T): AnyBody {
  const o = { ...item } as Record<string, unknown>
  for (const k of META_KEYS) delete o[k]
  // `enabled` is part of the body as well as the meta
  if ('enabled' in item) o.enabled = (item as { enabled?: boolean }).enabled
  return o as unknown as AnyBody
}

const pathOf = (p: PropertyKey[]): string => p.map(String).join('.') || '(root)'

/** zod issues as {path, message}. For an invalid union the most specific branch is reported, not "Invalid input". */
export function zodIssues(error: { issues: { path: PropertyKey[]; message: string; code?: string; errors?: unknown }[] }): Issue[] {
  const out: Issue[] = []
  const walk = (issues: typeof error.issues, base: PropertyKey[]) => {
    for (const i of issues) {
      const path = [...base, ...i.path]
      if (i.code === 'invalid_union' && Array.isArray(i.errors) && i.errors.length) {
        // pick the branch that got furthest (deepest path / fewest problems)
        const branches = i.errors as (typeof error.issues)[]
        const best = [...branches].sort((a, b) => Math.max(...b.map((x) => x.path.length), 0) - Math.max(...a.map((x) => x.path.length), 0) || a.length - b.length)[0]
        walk(best, path)
      } else out.push({ path: pathOf(path), message: i.message })
    }
  }
  walk(error.issues, [])
  return out
}

export type ParseResult<K extends ConfigKind = ConfigKind> = { ok: true; kind: K; body: BodyOf[K] } | { ok: false; errors: Issue[] }

/** Parse config JSON (a string or an object, with or without the bookkeeping fields) against the strict schema of its type. */
export function parseBody(input: unknown, expected?: ConfigKind): ParseResult {
  let value = input
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input)
    } catch (e) {
      return { ok: false, errors: [{ path: '(root)', message: `Not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }] }
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, errors: [{ path: '(root)', message: 'A configuration must be a JSON object' }] }
  const kind = typeToKind((value as { type?: unknown }).type)
  if (!kind) return { ok: false, errors: [{ path: 'type', message: `"type" must be one of calculation, conditional_rule, custom_field, automation, dashboard, dashboard_widget, filter, permission` }] }
  if (expected && kind !== expected) return { ok: false, errors: [{ path: 'type', message: `Expected a ${expected} but got a ${(value as { type: string }).type}` }] }
  const body = stripMeta(value as object) as unknown as Record<string, unknown>
  const res = SCHEMAS.bodies[kind].safeParse(body)
  if (!res.success) return { ok: false, errors: zodIssues(res.error as never) }
  return { ok: true, kind, body: res.data as never }
}

export type { AnyItem }
