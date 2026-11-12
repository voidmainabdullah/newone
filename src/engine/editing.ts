import type { Module, Role } from '#/types'
import { useModuleStore } from '#/stores/moduleStore'
import { useRecordStore } from '#/stores/recordStore'
import { recordTitle } from '#/utils/records'
import { Decimal } from '#/genius/formula/decimal'
import { outputFieldFor, runCalculation, scopeOf, toStored } from './calc'
import { graphFor } from './runtime'
import { stripMeta, type Issue } from './items'
import { liveRecordsOf, makeEnv, resolveField, resolveModule } from './resolve'
import { evaluateRule } from './rules'
import type { CalculationBody, ConditionalRuleBody, ConfigKind } from './schema'
import { validationEnvFor } from './service'
import { validateConfig } from './validate'

/**
 * Logic behind the Calculations / Rules tabs that is worth testing without a browser:
 * live JSON validation, blank templates for the guided forms, dependency info for the list, and the preview on real records.
 */

export type EditableKind = Extract<ConfigKind, 'calculations' | 'conditional_rules'>

export interface JsonCheck {
  ok: boolean
  errors: Issue[]
  cycle?: string[]
  kind?: ConfigKind
}

/** Validate what is in the JSON editor against the real project. Never throws; the editor shows the result as you type. */
export function checkJson(text: string, ws: string, opts: { expected: EditableKind; id?: string; role?: Role | null }): JsonCheck {
  if (!text.trim()) return { ok: false, errors: [{ path: '(root)', message: 'Write a configuration, or switch to the guided form' }] }
  const res = validateConfig(text, validationEnvFor(ws, { role: opts.role, existingId: opts.id }), opts.expected)
  return { ok: res.ok, errors: res.errors, cycle: res.cycle, kind: res.kind }
}

export const bodyOfItem = (item: object): Record<string, unknown> => stripMeta(item) as unknown as Record<string, unknown>
export const toJson = (body: object): string => JSON.stringify(body, null, 2)

export function blankCalculation(module: Module | undefined): CalculationBody {
  const nums = module?.fields.filter((f) => ['number', 'currency', 'percentage'].includes(f.type) && !f.calculated) ?? []
  return {
    type: 'calculation',
    name: 'New calculation',
    entity: module?.id ?? '',
    output_field: 'result',
    operation: 'subtract',
    inputs: nums.length >= 2 ? [{ field: nums[0].id, default: 0 }, { field: nums[1].id, default: 0 }] : [{ value: 0 }, { value: 0 }],
    trigger: 'on_record_change',
    auto_update: true,
  }
}

export function blankRule(module: Module | undefined): ConditionalRuleBody {
  const first = module?.fields.find((f) => !f.calculated && ['dropdown', 'radio', 'yesNo', 'number', 'currency', 'shortText'].includes(f.type))
  return {
    type: 'conditional_rule',
    name: 'New rule',
    entity: module?.id ?? '',
    trigger: 'on_record_change',
    mode: 'first_match',
    rules: [{ name: 'Rule 1', logic: 'AND', conditions: first ? [{ field: first.id, operator: 'is_not_empty' }] : [], actions: [] }],
  }
}

// ---- dependency info -------------------------------------------------------------------------------------------

export interface DependencyInfo {
  /** human names of the fields it reads / writes */
  reads: string[]
  writes: string[]
  /** other configs that must run before this one / that run after it */
  dependsOn: string[]
  usedBy: string[]
  inCycle: boolean
}

const labelOfKey = (modules: Module[], key: string): string => {
  const [mid, fid] = key.split('.')
  const m = modules.find((x) => x.id === mid)
  const f = m?.fields.find((x) => x.id === fid)
  return f ? `${m!.name}.${f.label}` : key.replace('.~', '.')
}

export function dependencyInfo(ws: string, id: string): DependencyInfo | undefined {
  const modules = useModuleStore.getState().modules.filter((m) => m.workspaceId === ws)
  const g = graphFor(ws)
  const node = g.nodes.find((n) => n.id === id)
  if (!node) return undefined
  const nameOf = new Map(g.nodes.map((n) => [n.id, n.name]))
  const usedBy = (g.edges.get(id) ?? []).map((x) => nameOf.get(x) ?? x)
  const dependsOn = [...g.edges.entries()].filter(([, to]) => to.includes(id)).map(([from]) => nameOf.get(from) ?? from)
  const names = new Set(g.cycle ?? [])
  return { reads: [...node.reads].map((k) => labelOfKey(modules, k)), writes: [...node.writes].map((k) => labelOfKey(modules, k)), dependsOn, usedBy, inCycle: names.has(node.name) }
}

// ---- preview ---------------------------------------------------------------------------------------------------

export interface PreviewRow {
  recordId?: string
  title: string
  /** what the record has now / what saving would write or do */
  before: string
  after: string
}

export interface Preview {
  ok: boolean
  rows: PreviewRow[]
  error?: string
  note?: string
}

const show = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : String(v))

/**
 * Run a configuration against up to `limit` real records WITHOUT saving or writing anything.
 * Calculations show current vs computed value; rules show which rule matched and what it would do.
 */
export function previewConfig(ws: string, body: CalculationBody | ConditionalRuleBody, opts: { limit?: number; now?: Date } = {}): Preview {
  const limit = opts.limit ?? 5
  try {
    const modules = useModuleStore.getState().modules.filter((m) => m.workspaceId === ws)
    const records = useRecordStore.getState().records.filter((r) => r.workspaceId === ws)
    const env = makeEnv(modules, records, opts.now ?? new Date())
    const module = resolveModule(modules, body.entity)
    if (!module) return { ok: false, rows: [], error: `Module "${body.entity}" does not exist` }
    const sample = liveRecordsOf(env, module.id).slice(0, limit)
    if (body.type === 'calculation') {
      if (scopeOf(body) === 'aggregate') {
        const res = runCalculation(body, env)
        const v = res.value instanceof Decimal ? res.value.toNumber() : res.value instanceof Date ? res.value.toISOString().slice(0, 10) : null
        const rows: PreviewRow[] = res.groups ? res.groups.slice(0, limit).map((g) => ({ title: g.label, before: '—', after: show(g.value?.toNumber()) })) : [{ title: `All ${module.name}`, before: '—', after: show(v) }]
        return { ok: true, rows, note: 'Aggregate: one result for the whole module (nothing is written to records).' }
      }
      if (!sample.length) return { ok: true, rows: [], note: `There are no ${module.name} records to preview yet.` }
      const out = body.output_field ? outputFieldFor(body, module, env) : undefined
      const rows = sample.map((r) => {
        const res = runCalculation(body, env, { record: r })
        const after = toStored(res.value, body, out?.field)
        return { recordId: r.id, title: recordTitle(module, r, env.ctx), before: show(out ? r.data[out.field.id] : undefined), after: show(after) }
      })
      return { ok: true, rows }
    }
    if (!sample.length) return { ok: true, rows: [], note: `There are no ${module.name} records to preview yet.` }
    const rows = sample.map((r) => {
      const outcome = evaluateRule(body, { module, record: r, env })
      const eff = outcome.effects.map((e) => (e.kind === 'set' ? `${resolveField(module, e.fieldId)?.label ?? e.fieldId} = ${show(e.value)}` : e.kind === 'calculate' ? `run calculation ${e.calculation}` : `run workflow ${e.workflowId}`))
      return { recordId: r.id, title: recordTitle(module, r, env.ctx), before: outcome.matched.length ? `rule ${outcome.matched.map((i) => body.rules[i].name || i + 1).join(', ')} matches` : 'no rule matches', after: eff.length ? eff.join('; ') : 'no change' }
    })
    return { ok: true, rows }
  } catch (e) {
    return { ok: false, rows: [], error: e instanceof Error ? e.message : String(e) }
  }
}

/** one line for the list: what the config does, in the project's own field names */
export function summarize(body: CalculationBody | ConditionalRuleBody, module: Module | undefined): string {
  const label = (ref: string) => (module ? resolveField(module, ref)?.label : undefined) ?? ref
  if (body.type === 'conditional_rule') {
    const n = body.rules.length
    return `${n} rule${n === 1 ? '' : 's'} · ${body.mode === 'all' ? 'every matching rule runs' : 'first match wins'}`
  }
  const parts = (body.inputs ?? []).map((i) => ('field' in i ? label(i.field) : 'value' in i ? String(i.value) : 'calculation'))
  const what = parts.length ? `${body.operation.replace(/_/g, ' ')}(${parts.join(', ')})` : body.operation.replace(/_/g, ' ')
  return body.output_field ? `${what} → ${label(body.output_field)}` : `${what} (summary)`
}

/** the people who may use the tabs: used to disable the editors for view-only roles (same keys the validator checks) */
export const canEditEngine = (role: Role | undefined, kind: EditableKind): boolean => !!role?.permissions[kind === 'calculations' ? 'manageFields' : 'manageWorkflows']