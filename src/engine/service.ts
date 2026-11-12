import type { Field, Role } from '#/types'
import { useWorkflowStore } from '#/stores/collections'
import { useEngineStore } from '#/stores/engineStore'
import { useModuleStore } from '#/stores/moduleStore'
import { useSettingsStore } from '#/stores/settingsStore'
import { useUserStore } from '#/stores/userStore'
import { uid } from '#/utils/id'
import { usesClock } from './dependencies'
import { type Issue } from './items'
import { resolveModule, slug } from './resolve'
import { recalculateConfig, ensureOutputFields, type RecalcReport } from './runtime'
import type { BodyOf, ConfigKind, ItemOf, Calculation, ConditionalRule } from './schema'
import { validateConfig, ENGINE_PERMISSION, type ValidationEnv } from './validate'

/**
 * The guarded entry points for saving configuration: parse -> semantic validation (fields, operators, types, cycles,
 * permission) -> store -> side effects (create the output field). The editors and the AI path both go through here, so an
 * invalid or unauthorised configuration can never reach the store or the runtime.
 */

export function currentRole(): Role | undefined {
  const uidNow = useSettingsStore.getState().settings.currentUserId
  const users = useUserStore.getState().users
  const user = users.find((u) => u.id === uidNow) ?? users[0]
  return useUserStore.getState().roles.find((r) => r.id === user?.roleId)
}

export function validationEnvFor(ws: string, opts: { role?: Role | null; existingId?: string } = {}): ValidationEnv {
  const doc = useEngineStore.getState().docOf(ws)
  return {
    modules: useModuleStore.getState().modules.filter((m) => m.workspaceId === ws),
    calculations: doc.calculations,
    rules: doc.conditional_rules,
    customFields: doc.custom_fields.filter((c) => c.enabled).map((c) => ({ entity: c.entity, name: c.name })),
    workflows: useWorkflowStore.getState().items.filter((w) => w.workspaceId === ws),
    permissions: doc.permissions,
    // null = explicitly no permission check (system code); undefined = the signed-in user's role
    role: opts.role === null ? undefined : (opts.role ?? currentRole()),
    existingId: opts.existingId,
  }
}

export interface SaveOptions {
  /** edit this config (replaces its body, version + 1) instead of creating a new one */
  id?: string
  expected?: ConfigKind
  /** null skips the permission check */
  role?: Role | null
  ownerId?: string
}

export interface SaveResult {
  ok: boolean
  errors: Issue[]
  kind?: ConfigKind
  item?: ItemOf[ConfigKind]
  cycle?: string[]
  warnings: string[]
  createdFields: string[]
}

const FIELD_TYPE: Record<string, Field['type']> = { number: 'number', currency: 'currency', percentage: 'percentage', shortText: 'shortText', date: 'date', yesNo: 'yesNo', dropdown: 'dropdown' }

export function saveConfig(ws: string, input: unknown, opts: SaveOptions = {}): SaveResult {
  const v = validateConfig(input, validationEnvFor(ws, { role: opts.role, existingId: opts.id }), opts.expected)
  if (!v.ok || !v.kind || !v.body) return { ok: false, errors: v.errors, kind: v.kind, cycle: v.cycle, warnings: [], createdFields: [] }
  const store = useEngineStore.getState()
  const kind = v.kind
  const meta = { ownerId: opts.ownerId ?? useSettingsStore.getState().settings.currentUserId ?? '' }
  const item = opts.id ? store.replace(ws, kind, opts.id, v.body as never) : store.add(ws, kind, v.body as never, meta)
  if (!item) return { ok: false, errors: [{ path: '(root)', message: `Configuration ${opts.id} was not found` }], kind, warnings: [], createdFields: [] }
  const warnings: string[] = []
  const createdFields: string[] = []
  if (kind === 'calculations') {
    const before = new Set(useModuleStore.getState().modules.flatMap((m) => m.fields.map((f) => f.id)))
    ensureOutputFields(ws)
    for (const m of useModuleStore.getState().modules) for (const f of m.fields) if (!before.has(f.id)) createdFields.push(`${m.name}.${f.label}`)
    if (usesClock(item as Calculation)) warnings.push('This calculation depends on today\'s date; it is refreshed once a day while the app is open.')
  } else if (kind === 'conditional_rules' && usesClock(item as ConditionalRule)) warnings.push('This rule depends on today\'s date; it is re-evaluated once a day while the app is open.')
  else if (kind === 'custom_fields') {
    const b = v.body as BodyOf['custom_fields']
    const m = resolveModule(useModuleStore.getState().modules.filter((x) => x.workspaceId === ws), b.entity)
    if (m) {
      const field: Field = {
        id: uid('fld'),
        name: slug(b.name),
        label: b.label ?? b.name,
        type: FIELD_TYPE[b.field_type],
        width: 'half',
        order: m.fields.length,
        visible: true,
        ...(b.field_type === 'dropdown' ? { options: (b.options ?? []).map((o) => ({ id: slug(o), label: o })) } : {}),
        ...(b.currency ? { currency: b.currency } : {}),
        ...(b.precision !== undefined ? { precision: b.precision } : {}),
        ...(b.calculated ? { calculated: true, readOnly: true } : {}),
        ...(b.sensitive ? { sensitive: true } : {}),
      } as Field
      useModuleStore.getState().addField(m.id, field)
      createdFields.push(`${m.name}.${field.label}`)
    }
  }
  return { ok: true, errors: [], kind, item, warnings, createdFields }
}

/** Delete a configuration. Needs the same permission as creating it. */
export function removeConfig(ws: string, kind: ConfigKind, id: string, role?: Role | null): { ok: boolean; error?: string } {
  const r = role === null ? undefined : (role ?? currentRole())
  if (r && !r.permissions[ENGINE_PERMISSION[kind]]) return { ok: false, error: `Your role "${r.name}" is not allowed to change ${kind.replace(/_/g, ' ')}` }
  useEngineStore.getState().remove(ws, kind, id)
  return { ok: true }
}

export function setConfigEnabled(ws: string, kind: ConfigKind, id: string, enabled: boolean, role?: Role | null): { ok: boolean; error?: string } {
  const r = role === null ? undefined : (role ?? currentRole())
  if (r && !r.permissions[ENGINE_PERMISSION[kind]]) return { ok: false, error: `Your role "${r.name}" is not allowed to change ${kind.replace(/_/g, ' ')}` }
  useEngineStore.getState().setEnabled(ws, kind, id, enabled)
  return { ok: true }
}

/** Save, then recalculate the saved config for every record (the "apply now" path). */
export async function saveAndRun(ws: string, input: unknown, opts: SaveOptions = {}): Promise<SaveResult & { report?: RecalcReport }> {
  const res = saveConfig(ws, input, opts)
  if (!res.ok || !res.item || (res.kind !== 'calculations' && res.kind !== 'conditional_rules')) return res
  return { ...res, report: await recalculateConfig(ws, res.item.id) }
}
