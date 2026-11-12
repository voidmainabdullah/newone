import type { Field, Module, PermissionKey, Role, Workflow } from '#/types'
import { can } from '#/genius/permissions/policy'
import { isWritableOutput, scopeOf } from './calc'
import { buildGraph, describeCycle, type ConfigNode } from './dependencies'
import { parseBody, type Issue, type ParseResult } from './items'
import { coerceForField, operatorsFor, statusFieldOf } from './rules'
import { isDateField, isNumberField, resolveField, resolveModule, slug, toDate, toDec } from './resolve'
import {
  isGroup,
  type Calculation,
  type CalcCore,
  type CalculationBody,
  type ConditionNode,
  type ConditionalRule,
  type ConditionalRuleBody,
  type ConfigKind,
  type DashboardBody,
  type DashboardWidgetShape,
  type Operator,
  type OperandValue,
  type PermissionRule,
  type BodyOf,
} from './schema'
import { EngineError } from './resolve'

/**
 * Semantic validation of a configuration against the REAL project schema, before it is saved or run.
 * zod (items.parseBody) answers "is this JSON shaped right"; this answers "does it make sense here":
 * modules and fields exist, operators fit the field type, numeric operations get numeric fields, the output field is not
 * its own source, there is no circular dependency, the person is allowed to change this kind of configuration, and every
 * widget has a source that exists. Nothing is saved or executed here. Errors are structured: { path, message }.
 */

export type { Issue }

/** the permission a role needs to create / edit / delete each kind of configuration (keys that already exist) */
export const ENGINE_PERMISSION: Record<ConfigKind, PermissionKey> = {
  calculations: 'manageFields',
  custom_fields: 'manageFields',
  conditional_rules: 'manageWorkflows',
  automations: 'manageWorkflows',
  dashboards: 'manageDashboards',
  dashboard_widgets: 'manageDashboards',
  filters: 'manageDashboards',
  permissions: 'accessSettings',
}

const AREA_OF: Partial<Record<ConfigKind, string>> = { calculations: 'calculations', conditional_rules: 'rules', dashboards: 'dashboards', dashboard_widgets: 'dashboards', custom_fields: 'custom_fields', automations: 'automations' }

export interface ValidationEnv {
  modules: Module[]
  /** the calculations and rules already saved in the workspace (the one being edited is replaced by `existingId`) */
  calculations: Calculation[]
  rules: ConditionalRule[]
  customFields?: { entity: string; name: string }[]
  workflows?: Pick<Workflow, 'id' | 'name' | 'moduleId'>[]
  permissions?: PermissionRule[]
  /** who is saving: without a role the permission check is skipped (system / tests) */
  role?: Role
  /** id of the config being edited, so it does not clash with its previous version */
  existingId?: string
}

export interface ValidationResult<K extends ConfigKind = ConfigKind> {
  ok: boolean
  errors: Issue[]
  kind?: K
  body?: BodyOf[K]
  /** names of the circular chain, when that is why it was refused */
  cycle?: string[]
}

const NEEDS_VALUE = new Set<Operator>(['equal', 'not_equal', 'greater_than', 'less_than', 'greater_than_or_equal', 'less_than_or_equal', 'contains', 'not_contains', 'between', 'before', 'after', 'in', 'not_in'])
const NUMERIC_OPS = new Set(['add', 'subtract', 'multiply', 'divide', 'percentage', 'percent_of', 'average', 'min', 'max', 'sum', 'sum_if'])
const BINARY_OPS = new Set(['percentage', 'percent_of', 'compare', 'date_diff'])

interface Ctx {
  env: ValidationEnv
  issues: Issue[]
  /** names other configs create: `moduleId` -> slugs */
  producible: Map<string, Set<string>>
}

const push = (c: Ctx, path: string, message: string) => c.issues.push({ path: path.replace(/^\./, '') || '(root)', message })

function producibleMap(env: ValidationEnv): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  const add = (entity: string, name: string) => {
    const m = resolveModule(env.modules, entity)
    if (!m) return
    ;(out.get(m.id) ?? out.set(m.id, new Set()).get(m.id)!).add(slug(name))
  }
  for (const c of env.calculations) if (c.id !== env.existingId && c.output_field && c.enabled) add(c.entity, c.output_field)
  for (const f of env.customFields ?? []) add(f.entity, f.name)
  return out
}

/** resolve a field reference; a name another config is going to create counts as known (type unknown) */
function lookup(c: Ctx, module: Module, ref: string, path: string): { field?: Field; ok: boolean } {
  const field = resolveField(module, ref)
  if (field) return { field, ok: true }
  if (c.producible.get(module.id)?.has(slug(ref))) return { ok: true }
  const names = module.fields.slice(0, 12).map((f) => f.name).join(', ')
  push(c, path, `Field "${ref}" does not exist in "${module.name}"${names ? ` (fields: ${names})` : ''}`)
  return { ok: false }
}

function moduleOf(c: Ctx, entity: string, path: string): Module | undefined {
  const m = resolveModule(c.env.modules, entity)
  if (!m) push(c, path, `Module "${entity}" does not exist (modules: ${c.env.modules.filter((x) => !x.archived).map((x) => x.name).join(', ') || 'none'})`)
  return m
}

// ---- conditions ------------------------------------------------------------------------------------------------

function checkOperand(c: Ctx, module: Module, v: OperandValue | undefined, path: string) {
  if (Array.isArray(v)) v.forEach((x, i) => checkOperand(c, module, x, `${path}.${i}`))
  else if (v && typeof v === 'object' && 'field' in v) lookup(c, module, v.field, `${path}.field`)
}

function checkCondition(c: Ctx, module: Module, n: ConditionNode, path: string) {
  if (isGroup(n)) {
    if (!n.conditions.length) push(c, `${path}.conditions`, 'A condition group needs at least one condition')
    n.conditions.forEach((x, i) => checkCondition(c, module, x, `${path}.conditions.${i}`))
    return
  }
  const { field } = lookup(c, module, n.field, `${path}.field`)
  checkOperand(c, module, n.value, `${path}.value`)
  if (NEEDS_VALUE.has(n.operator) && (n.value === undefined || n.value === null) && n.operator !== 'equal' && n.operator !== 'not_equal') push(c, `${path}.value`, `Operator "${n.operator}" needs a value`)
  if ((n.operator === 'equal' || n.operator === 'not_equal') && n.value === undefined) push(c, `${path}.value`, `Operator "${n.operator}" needs a value (use null to compare with empty)`)
  if (n.operator === 'between' && !(Array.isArray(n.value) && n.value.length === 2)) push(c, `${path}.value`, '"between" needs a [from, to] pair')
  if ((n.operator === 'in' || n.operator === 'not_in') && !Array.isArray(n.value)) push(c, `${path}.value`, `"${n.operator}" needs a list of values`)
  if (!field) return
  if (!operatorsFor(field).includes(n.operator)) {
    push(c, `${path}.operator`, `Operator "${n.operator}" cannot be used on ${field.type} field "${field.label}" (allowed: ${operatorsFor(field).join(', ')})`)
    return
  }
  // literal values must be usable for the field
  const lits = (Array.isArray(n.value) ? n.value : [n.value]).filter((x) => x !== undefined && x !== null && !(typeof x === 'object'))
  if (isNumberField(field)) for (const l of lits) if (!toDec(l)) push(c, `${path}.value`, `"${String(l)}" is not a number, but "${field.label}" is a numeric field`)
  if (isDateField(field) || n.operator === 'before' || n.operator === 'after') for (const l of lits) if (!['today', 'now'].includes(String(l).toLowerCase()) && !toDate(l)) push(c, `${path}.value`, `"${String(l)}" is not a date (use YYYY-MM-DD, "today" or "now")`)
}

// ---- calculations ----------------------------------------------------------------------------------------------

function numericField(c: Ctx, module: Module, ref: string, path: string, why: string) {
  const { field } = lookup(c, module, ref, path)
  if (field && !isNumberField(field)) push(c, path, `"${field.label}" is a ${field.type} field; ${why} needs a number, currency or percentage field`)
  return field
}

function checkCore(c: Ctx, core: CalcCore, module: Module, path: string, scope: 'record' | 'aggregate') {
  const op = core.operation
  const inputs = core.inputs ?? []
  let src = module
  if (core.related) {
    const rel = moduleOf(c, core.related.entity, `${path}.related.entity`)
    if (rel) {
      src = rel
      const there = resolveField(rel, core.related.via)
      const here = resolveField(module, core.related.via)
      const okThere = there?.type === 'relationship' && there.relation?.moduleId === module.id
      const okHere = here?.type === 'relationship' && here.relation?.moduleId === rel.id
      if (!okThere && !okHere) push(c, `${path}.related.via`, `"${core.related.via}" is not a relationship field between "${module.name}" and "${rel.name}"`)
    } else src = module
  } else if ((op === 'count_if' || op === 'sum_if') && scope === 'record') push(c, `${path}.operation`, `"${op}" counts records: use scope "aggregate", or add "related" to count related records`)
  if ((op === 'count_if' || op === 'sum_if') && !core.filters?.length) push(c, `${path}.filters`, `"${op}" needs at least one filter`)
  if (BINARY_OPS.has(op) && inputs.length !== 2) push(c, `${path}.inputs`, `"${op}" needs exactly 2 inputs, got ${inputs.length}`)
  if ((op === 'subtract' || op === 'divide') && inputs.length < 2) push(c, `${path}.inputs`, `"${op}" needs at least 2 inputs`)
  if ((op === 'add' || op === 'multiply') && inputs.length < 1) push(c, `${path}.inputs`, `"${op}" needs inputs`)
  if (op === 'date_add' && inputs.length !== 1) push(c, `${path}.inputs`, '"date_add" needs one date input and an "amount"')
  if (op === 'date_add' && core.amount === undefined) push(c, `${path}.amount`, '"date_add" needs "amount" (a number or a { field })')
  if (op === 'if') {
    if (!core.condition) push(c, `${path}.condition`, '"if" needs a "condition"')
    else checkCondition(c, module, core.condition, `${path}.condition`)
    if (!core.then) push(c, `${path}.then`, '"if" needs "then"')
    if (scope === 'aggregate') push(c, `${path}.operation`, '"if" runs per record; use it with an output_field, not in an aggregate calculation')
  }
  if (core.filters) core.filters.forEach((f, i) => checkCondition(c, src, f, `${path}.filters.${i}`))
  const aggregateLike = core.related || scope === 'aggregate'
  if ((op === 'sum' || op === 'average' || op === 'min' || op === 'max' || op === 'sum_if') && aggregateLike && !inputs.length) push(c, `${path}.inputs`, `"${op}" over records needs a { "field" } input`)
  inputs.forEach((i, idx) => {
    const p = `${path}.inputs.${idx}`
    if ('field' in i) {
      if (aggregateLike && !core.related && scope === 'aggregate' && !AGG_OK.has(op)) push(c, p, `a plain field cannot be used in "${op}" over many records; wrap it in { "calc": { "operation": "sum", "inputs": [...] } }`)
      if (NUMERIC_OPS.has(op)) numericField(c, src, i.field, `${p}.field`, `"${op}"`)
      else if (op === 'date_diff' || op === 'date_add') {
        const { field } = lookup(c, src, i.field, `${p}.field`)
        if (field && !isDateField(field)) push(c, `${p}.field`, `"${field.label}" is a ${field.type} field; "${op}" needs a date field`)
      } else if (op === 'compare') lookup(c, src, i.field, `${p}.field`)
      else lookup(c, src, i.field, `${p}.field`)
    } else if ('calc' in i) checkCore(c, i.calc, module, `${p}.calc`, scope)
  })
  if (typeof core.amount === 'object' && core.amount) numericField(c, module, core.amount.field, `${path}.amount.field`, '"amount"')
  for (const k of ['then', 'else'] as const) {
    const b = core[k]
    if (b && 'field' in b) lookup(c, module, b.field, `${path}.${k}.field`)
    else if (b && 'calc' in b) checkCore(c, b.calc, module, `${path}.${k}.calc`, scope)
  }
}
const AGG_OK = new Set(['sum', 'average', 'min', 'max', 'count', 'count_if', 'sum_if'])

function checkCalculation(c: Ctx, calc: CalculationBody) {
  const module = moduleOf(c, calc.entity, 'entity')
  if (!module) return
  const scope = scopeOf(calc)
  checkCore(c, calc, module, '', scope)
  if (calc.groupBy) {
    lookup(c, module, calc.groupBy, 'groupBy')
    if (!AGG_OK.has(calc.operation)) push(c, 'groupBy', 'groupBy needs an aggregate operation (sum, average, min, max, count, count_if, sum_if)')
  }
  const range = calc.dateRange
  if (typeof range === 'object') {
    if (range.preset === 'custom' && !range.from && !range.to) push(c, 'dateRange', 'A custom range needs "from" and/or "to"')
    if (range.from && !toDate(range.from)) push(c, 'dateRange.from', `"${range.from}" is not a date`)
    if (range.to && !toDate(range.to)) push(c, 'dateRange.to', `"${range.to}" is not a date`)
    if (range.field) {
      const { field } = lookup(c, module, range.field, 'dateRange.field')
      if (field && !isDateField(field)) push(c, 'dateRange.field', `"${field.label}" is not a date field`)
    }
    if (range.bucket && !AGG_OK.has(calc.operation)) push(c, 'dateRange.bucket', 'A period bucket needs an aggregate operation')
    if (range.bucket && calc.groupBy) push(c, 'dateRange.bucket', 'Use either groupBy or a period bucket, not both')
  }
  if (scope === 'record') {
    if (!calc.output_field) push(c, 'output_field', 'A per-record calculation needs an output_field to write the result to')
    else {
      const out = resolveField(module, calc.output_field)
      if (out) {
        if (!isWritableOutput(out)) push(c, 'output_field', `"${out.label}" is a ${out.type} field and cannot hold a calculated number or date`)
        else if (!out.calculated) push(c, 'output_field', `"${out.label}" is a regular field people type into; calculations only write calculated fields. Choose a new output_field name (it is created for you) or mark this field as calculated`)
        const self = selfReads(calc, module)
        if (self) push(c, 'output_field', `The output field "${out.label}" is also an input of this calculation; a result cannot be its own source`)
      } else if (selfReads(calc, module)) push(c, 'output_field', `The output field "${calc.output_field}" is also an input of this calculation; a result cannot be its own source`)
    }
  } else if (calc.output_field && !calc.related) push(c, 'output_field', 'An aggregate calculation returns a value for widgets; remove output_field, or use scope "record" with "related" to store a total on each record')
}

function selfReads(calc: CalculationBody, module: Module): boolean {
  const target = calc.output_field ? slug(calc.output_field) : ''
  const out = calc.output_field ? resolveField(module, calc.output_field) : undefined
  let hit = false
  const same = (ref: string, m: Module) => m.id === module.id && (slug(ref) === target || (!!out && resolveField(m, ref)?.id === out.id))
  const walk = (core: CalcCore) => {
    const src = core.related ? resolveModule([module], core.related.entity) ?? module : module
    for (const i of core.inputs ?? []) {
      if ('field' in i && !core.related && same(i.field, src)) hit = true
      else if ('calc' in i) walk(i.calc)
    }
    for (const b of [core.then, core.else]) {
      if (b && 'field' in b && same(b.field, module)) hit = true
      else if (b && 'calc' in b) walk(b.calc)
    }
  }
  walk(calc)
  return hit
}

// ---- rules -----------------------------------------------------------------------------------------------------

function checkRule(c: Ctx, rule: ConditionalRuleBody) {
  const module = moduleOf(c, rule.entity, 'entity')
  if (!module) return
  rule.rules.forEach((r, i) => {
    const p = `rules.${i}`
    if (!r.conditions.length) push(c, `${p}.conditions`, 'A rule needs at least one condition')
    r.conditions.forEach((n, j) => checkCondition(c, module, n, `${p}.conditions.${j}`))
    const actions = [...(r.action ? [r.action] : []), ...(r.actions ?? [])]
    if (!actions.length) push(c, p, 'A rule needs an "action" or "actions"')
    actions.forEach((a, k) => {
      const ap = r.action && k === 0 ? `${p}.action` : `${p}.actions.${k - (r.action ? 1 : 0)}`
      switch (a.type) {
        case 'update_field': {
          const { field } = lookup(c, module, a.field, `${ap}.field`)
          checkOperand(c, module, a.value, `${ap}.value`)
          if (field) {
            if (field.type === 'formula' || field.type === 'autoId') push(c, `${ap}.field`, `"${field.label}" is computed and cannot be written by a rule`)
            else if (a.value !== null && !(typeof a.value === 'object')) {
              try {
                coerceForField(field, a.value)
              } catch (e) {
                push(c, `${ap}.value`, e instanceof EngineError ? e.message : 'Invalid value')
              }
            }
          }
          break
        }
        case 'set_status': {
          const field = a.field ? lookup(c, module, a.field, `${ap}.field`).field : statusFieldOf(module)
          if (!a.field && !field) push(c, ap, `"${module.name}" has no status field; name the field in "field"`)
          if (field) {
            try {
              coerceForField(field, a.value)
            } catch (e) {
              push(c, `${ap}.value`, e instanceof EngineError ? e.message : 'Invalid value')
            }
          }
          break
        }
        case 'calculate': {
          const target = c.env.calculations.find((x) => x.id === a.calculation || x.name === a.calculation)
          if (!target) push(c, `${ap}.calculation`, `Calculation "${a.calculation}" does not exist`)
          else if (resolveModule(c.env.modules, target.entity)?.id !== module.id) push(c, `${ap}.calculation`, `"${target.name}" runs on "${target.entity}", not on "${module.name}"`)
          break
        }
        case 'run_automation': {
          const wf = c.env.workflows?.find((w) => w.id === a.workflow_id)
          if (!wf) push(c, `${ap}.workflow_id`, `Workflow "${a.workflow_id}" does not exist`)
          else if (wf.moduleId !== module.id) push(c, `${ap}.workflow_id`, `Workflow "${wf.name}" belongs to a different module than "${module.name}"`)
          break
        }
      }
    })
  })
}

// ---- dashboards ------------------------------------------------------------------------------------------------

const NEEDS_SOURCE = new Set(['kpi', 'revenue', 'profit_loss', 'record_count', 'average', 'percentage', 'progress', 'line_chart', 'bar_chart', 'pie_chart', 'doughnut_chart', 'table', 'recent_records', 'status_breakdown', 'conditional_stat'])

export function checkWidget(c: Ctx, w: DashboardWidgetShape, path: string) {
  if (w.type === 'calculation') {
    if (!w.calculation) push(c, `${path}.calculation`, 'A calculation widget needs a "calculation" (a saved calculation id or name, or an inline aggregate calculation)')
    else if (typeof w.calculation === 'string') {
      if (!c.env.calculations.some((x) => x.id === w.calculation || x.name === w.calculation)) push(c, `${path}.calculation`, `Calculation "${w.calculation}" does not exist`)
    } else {
      const inner: Ctx = { ...c, issues: [] }
      checkCalculation(inner, w.calculation)
      for (const i of inner.issues) push(c, `${path}.calculation${i.path ? `.${i.path}` : ''}`, i.message)
    }
  }
  const s = w.source
  if (!s) {
    if (NEEDS_SOURCE.has(w.type)) push(c, `${path}.source`, `A ${w.type} widget needs a "source" with an entity`)
    return
  }
  if (!s.entity) {
    if (NEEDS_SOURCE.has(w.type)) push(c, `${path}.source.entity`, 'The source needs an entity')
    return
  }
  const module = moduleOf(c, s.entity, `${path}.source.entity`)
  if (!module) return
  const agg = s.aggregation ?? (w.type === 'record_count' ? 'count' : undefined)
  if (s.field) {
    const { field } = lookup(c, module, s.field, `${path}.source.field`)
    if (field && agg && agg !== 'count' && !isNumberField(field)) push(c, `${path}.source.field`, `"${agg}" needs a number, currency or percentage field, but "${field.label}" is ${field.type}`)
  } else if (agg && agg !== 'count' && w.type !== 'calculation') push(c, `${path}.source.field`, `"${agg}" needs a source field`)
  if (['revenue', 'profit_loss', 'average'].includes(w.type) && !s.field) push(c, `${path}.source.field`, `A ${w.type} widget needs a numeric source field`)
  if (w.type === 'profit_loss') {
    if (!s.expenseField) push(c, `${path}.source.expenseField`, 'A profit_loss widget needs an expenseField')
    else numericField(c, module, s.expenseField, `${path}.source.expenseField`, 'the expense')
  }
  if (s.field && ['revenue', 'profit_loss', 'average'].includes(w.type)) numericField(c, module, s.field, `${path}.source.field`, `a ${w.type} widget`)
  if (s.groupBy) lookup(c, module, s.groupBy, `${path}.source.groupBy`)
  if (s.dateField) {
    const { field } = lookup(c, module, s.dateField, `${path}.source.dateField`)
    if (field && !isDateField(field)) push(c, `${path}.source.dateField`, `"${field.label}" is not a date field`)
  }
  if (typeof s.dateRange === 'object' && s.dateRange.field) {
    const { field } = lookup(c, module, s.dateRange.field, `${path}.source.dateRange.field`)
    if (field && !isDateField(field)) push(c, `${path}.source.dateRange.field`, `"${field.label}" is not a date field`)
  }
  if (w.type === 'percentage' && !s.filters?.length) push(c, `${path}.source.filters`, 'A percentage widget needs filters: the share of records that match them')
  if (w.type === 'conditional_stat' && !s.filters?.length) push(c, `${path}.source.filters`, 'A conditional statistic needs filters')
  if (w.type === 'progress' && w.target === undefined) push(c, `${path}.target`, 'A progress widget needs a target')
  s.filters?.forEach((f, i) => checkCondition(c, module, f, `${path}.source.filters.${i}`))
}

function checkDashboard(c: Ctx, d: DashboardBody) {
  const ids = new Set<string>()
  d.widgets.forEach((w, i) => {
    if (ids.has(w.id)) push(c, `widgets.${i}.id`, `Duplicate widget id "${w.id}"`)
    ids.add(w.id)
    checkWidget(c, w, `widgets.${i}`)
  })
  if (d.scope === 'user' && !d.userId) push(c, 'userId', 'A per-user dashboard needs a userId')
}

// ---- entry point -----------------------------------------------------------------------------------------------

/** Cycle check for a calculation or rule against everything already saved. Returns the named cycle, or null. */
export function findCycle(kind: 'calculations' | 'conditional_rules', candidate: Calculation | ConditionalRule, env: Pick<ValidationEnv, 'modules' | 'calculations' | 'rules'>): string[] | null {
  const calcs = env.calculations.filter((x) => x.enabled && x.id !== candidate.id)
  const rules = env.rules.filter((x) => x.enabled && x.id !== candidate.id)
  const items: ConfigNode[] = [
    ...calcs.map((config) => ({ kind: 'calculation' as const, config })),
    ...rules.map((config) => ({ kind: 'rule' as const, config })),
    kind === 'calculations' ? { kind: 'calculation' as const, config: candidate as Calculation } : { kind: 'rule' as const, config: candidate as ConditionalRule },
  ]
  return buildGraph(items, env.modules).cycle
}

function permissionIssue(kind: ConfigKind, env: ValidationEnv): Issue | null {
  if (!env.role) return null
  const key = ENGINE_PERMISSION[kind]
  if (!can(env.role, key)) return { path: '(permission)', message: `Your role "${env.role.name}" is not allowed to change ${kind.replace(/_/g, ' ')} (needs "${key}")` }
  const area = AREA_OF[kind]
  const denied = env.permissions?.find((p) => p.enabled && p.role_id === env.role!.id && p.area === area && !p.allow)
  if (denied) return { path: '(permission)', message: `A workspace permission rule denies the role "${env.role.name}" access to ${area}` }
  return null
}

/** Validate a configuration (JSON string, object, or an already parsed body) for saving. */
export function validateConfig(input: unknown, env: ValidationEnv, expected?: ConfigKind): ValidationResult {
  const parsed: ParseResult = parseBody(input, expected)
  if (!parsed.ok) return { ok: false, errors: parsed.errors }
  const kind = parsed.kind
  const issues: Issue[] = []
  const perm = permissionIssue(kind, env)
  if (perm) return { ok: false, errors: [perm], kind }
  const c: Ctx = { env, issues, producible: producibleMap(env) }
  switch (kind) {
    case 'calculations': {
      const b = parsed.body as CalculationBody
      checkCalculation(c, b)
      if (!issues.length) {
        const cycle = findCycle('calculations', { ...b, id: env.existingId ?? '__candidate__', enabled: b.enabled ?? true } as Calculation, env)
        if (cycle) return { ok: false, errors: [{ path: '(dependencies)', message: describeCycle(cycle) }], kind, cycle }
      }
      break
    }
    case 'conditional_rules': {
      const b = parsed.body as ConditionalRuleBody
      checkRule(c, b)
      if (!issues.length) {
        const cycle = findCycle('conditional_rules', { ...b, id: env.existingId ?? '__candidate__', enabled: b.enabled ?? true } as ConditionalRule, env)
        if (cycle) return { ok: false, errors: [{ path: '(dependencies)', message: describeCycle(cycle) }], kind, cycle }
      }
      break
    }
    case 'custom_fields': {
      const b = parsed.body as BodyOf['custom_fields']
      const m = moduleOf(c, b.entity, 'entity')
      if (m) {
        const clash = resolveField(m, b.name)
        if (clash) push(c, 'name', `"${m.name}" already has a field "${clash.label}"`)
      }
      if (b.field_type === 'dropdown' && !b.options?.length) push(c, 'options', 'A dropdown field needs options')
      break
    }
    case 'automations': {
      const b = parsed.body as BodyOf['automations']
      const m = moduleOf(c, b.entity, 'entity')
      b.steps.forEach((s, i) => {
        const found = s.kind === 'calculation' ? env.calculations.some((x) => x.id === s.ref || x.name === s.ref) : s.kind === 'rule' ? env.rules.some((x) => x.id === s.ref || x.name === s.ref) : !!env.workflows?.some((x) => x.id === s.ref)
        if (!found) push(c, `steps.${i}.ref`, `${s.kind} "${s.ref}" does not exist`)
      })
      void m
      break
    }
    case 'filters': {
      const b = parsed.body as BodyOf['filters']
      const m = moduleOf(c, b.entity, 'entity')
      if (m) b.filters.forEach((f, i) => checkCondition(c, m, f, `filters.${i}`))
      break
    }
    case 'dashboards':
      checkDashboard(c, parsed.body as DashboardBody)
      break
    case 'dashboard_widgets':
      checkWidget(c, (parsed.body as BodyOf['dashboard_widgets']).widget, 'widget')
      break
    case 'permissions':
      break
  }
  return { ok: issues.length === 0, errors: issues, kind, body: issues.length ? undefined : (parsed.body as never) }
}

export const formatIssues = (issues: Issue[]): string => issues.map((i) => `${i.path}: ${i.message}`).join('\n')
