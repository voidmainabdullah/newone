import { z } from 'zod'

/**
 * Versioned workspace configuration of the calculation / rules / dashboard engine.
 *
 * Eight separate collections, all plain JSON (JSONB friendly): calculations, conditional_rules, custom_fields,
 * automations, dashboards, dashboard_widgets, filters, permissions. Every stored item carries
 * id, version, enabled, createdAt, updatedAt, ownerId and workspaceId.
 *
 * `entity` and `field` inside a config are the module's / field's API name (or id); resolve.ts maps them onto the real
 * module schema and validate.ts reports the ones that do not exist. The "Body" schemas are what a person or the AI
 * writes; the stored "Item" adds the bookkeeping fields. Nothing in this file touches a store or executes anything.
 */

export const ENGINE_SCHEMA_VERSION = 1

export const CONFIG_KINDS = ['calculations', 'conditional_rules', 'custom_fields', 'automations', 'dashboards', 'dashboard_widgets', 'filters', 'permissions'] as const
export type ConfigKind = (typeof CONFIG_KINDS)[number]

/** the `type` literal of a config body for each collection */
export const KIND_TYPE: Record<ConfigKind, string> = {
  calculations: 'calculation',
  conditional_rules: 'conditional_rule',
  custom_fields: 'custom_field',
  automations: 'automation',
  dashboards: 'dashboard',
  dashboard_widgets: 'dashboard_widget',
  filters: 'filter',
  permissions: 'permission',
}
export const typeToKind = (t: unknown): ConfigKind | undefined => CONFIG_KINDS.find((k) => KIND_TYPE[k] === t)

// ---- vocabulary ------------------------------------------------------------------------------------------------

export const OPERATORS = ['equal', 'not_equal', 'greater_than', 'less_than', 'greater_than_or_equal', 'less_than_or_equal', 'contains', 'not_contains', 'is_empty', 'is_not_empty', 'is_true', 'is_false', 'between', 'before', 'after', 'in', 'not_in'] as const
export type Operator = (typeof OPERATORS)[number]

export const OPERATIONS = ['add', 'subtract', 'multiply', 'divide', 'percentage', 'percent_of', 'average', 'min', 'max', 'count', 'sum', 'count_if', 'sum_if', 'date_diff', 'date_add', 'compare', 'if'] as const
export type Operation = (typeof OPERATIONS)[number]

/** how a config is started: after a record write, on a schedule while the app is open, or only by hand */
export const TRIGGERS = ['on_record_change', 'schedule', 'manual'] as const
export type Trigger = (typeof TRIGGERS)[number]
export const RULE_TRIGGERS = ['on_record_change', 'on_create', 'schedule', 'manual'] as const
export type RuleTrigger = (typeof RULE_TRIGGERS)[number]

export const SCHEDULES = ['on_open', 'hourly', 'daily'] as const
export type Schedule = (typeof SCHEDULES)[number]

export const PRESETS = ['all', 'today', 'this_week', 'this_month', 'last_month', 'last_7_days', 'last_30_days', 'last_90_days', 'this_year', 'custom'] as const
export type Preset = (typeof PRESETS)[number]
export const BUCKETS = ['day', 'week', 'month', 'year'] as const
export type Bucket = (typeof BUCKETS)[number]
export const UNITS = ['days', 'weeks', 'months', 'years'] as const
export type Unit = (typeof UNITS)[number]
export const AGGREGATIONS = ['count', 'sum', 'average', 'min', 'max'] as const
export type Aggregation = (typeof AGGREGATIONS)[number]

export const WIDGET_KINDS = ['kpi', 'revenue', 'profit_loss', 'record_count', 'average', 'percentage', 'progress', 'line_chart', 'bar_chart', 'pie_chart', 'doughnut_chart', 'table', 'recent_activity', 'recent_records', 'status_breakdown', 'conditional_stat', 'calculation'] as const
export type WidgetKind = (typeof WIDGET_KINDS)[number]

export const ACTION_TYPES = ['update_field', 'set_status', 'calculate', 'run_automation'] as const
export const PERMISSION_AREAS = ['calculations', 'rules', 'dashboards', 'custom_fields', 'automations'] as const
export type PermissionArea = (typeof PERMISSION_AREAS)[number]

// ---- shared pieces ---------------------------------------------------------------------------------------------

const Ref = z.string().min(1).max(120)
const Literal = z.union([z.string().max(500), z.number(), z.boolean(), z.null()])
export type LiteralValue = string | number | boolean | null
const FieldRef = z.strictObject({ field: Ref })
const Operand = z.union([Literal, FieldRef, z.array(z.union([Literal, FieldRef])).max(50)])
/** a literal, another field of the same record, or (between / in / not_in) a list of those */
export type OperandValue = LiteralValue | { field: string } | (LiteralValue | { field: string })[]

export const ConditionSchema = z.strictObject({ field: Ref, operator: z.enum(OPERATORS), value: Operand.optional() })
export interface Condition {
  field: string
  operator: Operator
  value?: OperandValue
}
/** AND (default) / OR over conditions and further groups, nested to any depth */
export interface ConditionGroup {
  logic?: 'AND' | 'OR'
  conditions: ConditionNode[]
}
export type ConditionNode = Condition | ConditionGroup
export const isGroup = (n: ConditionNode): n is ConditionGroup => !!n && typeof n === 'object' && 'conditions' in n

function nodeSchema(depth: number): z.ZodType {
  const cond = z.union([ConditionSchema, z.strictObject({ logic: z.enum(['AND', 'OR']).optional(), conditions: z.array(depth > 0 ? nodeSchema(depth - 1) : ConditionSchema).max(50) })])
  return cond
}
const Nodes = (depth: number) => z.array(nodeSchema(depth)).max(50)

const RangePreset = z.enum(PRESETS)
export const DateRangeSchema = z.union([RangePreset, z.strictObject({ preset: RangePreset, from: z.string().max(40).optional(), to: z.string().max(40).optional(), field: Ref.optional(), bucket: z.enum(BUCKETS).optional() })])
/** a preset name, or { preset, from, to, field (the date field), bucket (group the result by day/week/month/year) } */
export type DateRangeSpec = Preset | { preset: Preset; from?: string; to?: string; field?: string; bucket?: Bucket }

const Related = z.strictObject({ entity: Ref, via: Ref })
/** aggregate the records of another module that point at this record (or that this record points at) through a relationship field */
export interface Related {
  entity: string
  via: string
}

// ---- actions ---------------------------------------------------------------------------------------------------

export const ActionSchema = z.union([
  z.strictObject({ type: z.literal('update_field'), field: Ref, value: Operand }),
  z.strictObject({ type: z.literal('set_status'), field: Ref.optional(), value: z.string().max(200) }),
  z.strictObject({ type: z.literal('calculate'), calculation: Ref }),
  z.strictObject({ type: z.literal('run_automation'), workflow_id: Ref }),
])
export type Action =
  | { type: 'update_field'; field: string; value: OperandValue }
  | { type: 'set_status'; field?: string; value: string }
  /** run a saved calculation (id or name) for this record */
  | { type: 'calculate'; calculation: string }
  /** run an existing CRM workflow (src/services/workflowEngine) for this record */
  | { type: 'run_automation'; workflow_id: string }

// ---- calculations ----------------------------------------------------------------------------------------------

export type Input = { field: string; default?: number | string } | { value: LiteralValue } | { calc: CalcCore }

export interface CalcCore {
  operation: Operation
  inputs?: Input[]
  /** count_if / sum_if (and every aggregate): only records matching these are counted */
  filters?: ConditionNode[]
  /** `if`: the condition, then / else are inputs */
  condition?: ConditionNode
  then?: Input
  else?: Input
  /** date_diff / date_add */
  unit?: Unit
  /** date_add: how many units to add */
  amount?: number | { field: string }
  related?: Related
  precision?: number
}

export interface OutputSpec {
  label?: string
  type?: 'number' | 'currency' | 'percentage' | 'date'
  precision?: number
  currency?: string
}

export interface CalculationBody extends CalcCore {
  type: 'calculation'
  name: string
  entity: string
  /** record scope: the field that receives the result (created as a calculated, read-only field when missing) */
  output_field?: string
  /** 'record' (default): one value per record. 'aggregate': one scalar or series over the whole module */
  scope?: 'record' | 'aggregate'
  groupBy?: string
  dateRange?: DateRangeSpec
  trigger?: Trigger
  /** false: only runs on "Recalculate" */
  auto_update?: boolean
  /** trigger 'schedule' */
  schedule?: Schedule
  output?: OutputSpec
  enabled?: boolean
}

const inputSchema = (depth: number): z.ZodType => {
  const leaf: z.ZodType[] = [z.strictObject({ field: Ref, default: z.union([z.number(), z.string().max(40)]).optional() }), z.strictObject({ value: Literal })]
  if (depth > 0) leaf.push(z.strictObject({ calc: z.strictObject(calcShape(depth - 1)) }))
  return z.union(leaf as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]])
}

function calcShape(depth: number): Record<string, z.ZodType> {
  return {
    operation: z.enum(OPERATIONS),
    inputs: z.array(inputSchema(depth)).max(30).optional(),
    filters: Nodes(Math.min(depth, 3)).optional(),
    condition: nodeSchema(Math.min(depth, 3)).optional(),
    then: inputSchema(depth).optional(),
    else: inputSchema(depth).optional(),
    unit: z.enum(UNITS).optional(),
    amount: z.union([z.number(), FieldRef]).optional(),
    related: Related.optional(),
    precision: z.number().int().min(0).max(12).optional(),
  }
}

const calculationBody = (depth: number) =>
  z.strictObject({
    type: z.literal('calculation'),
    name: z.string().min(1).max(120),
    entity: Ref,
    output_field: Ref.optional(),
    ...calcShape(depth),
    scope: z.enum(['record', 'aggregate']).optional(),
    groupBy: Ref.optional(),
    dateRange: DateRangeSchema.optional(),
    trigger: z.enum(TRIGGERS).optional(),
    auto_update: z.boolean().optional(),
    schedule: z.enum(SCHEDULES).optional(),
    output: z.strictObject({ label: z.string().max(120).optional(), type: z.enum(['number', 'currency', 'percentage', 'date']).optional(), precision: z.number().int().min(0).max(12).optional(), currency: z.string().max(3).optional() }).optional(),
    enabled: z.boolean().optional(),
  })

// ---- conditional rules -----------------------------------------------------------------------------------------

export interface RuleItem {
  name?: string
  /** conditions and nested groups, combined with `logic` (AND by default) */
  conditions: ConditionNode[]
  logic?: 'AND' | 'OR'
  action?: Action
  actions?: Action[]
}

export interface ConditionalRuleBody {
  type: 'conditional_rule'
  name: string
  entity: string
  trigger?: RuleTrigger
  /** first_match (default): the first rule whose conditions hold wins and the rest are skipped; all: every matching rule runs in order */
  mode?: 'first_match' | 'all'
  rules: RuleItem[]
  schedule?: Schedule
  enabled?: boolean
}

const conditionalRuleBody = (depth: number) =>
  z.strictObject({
    type: z.literal('conditional_rule'),
    name: z.string().min(1).max(120),
    entity: Ref,
    trigger: z.enum(RULE_TRIGGERS).optional(),
    mode: z.enum(['first_match', 'all']).optional(),
    rules: z
      .array(z.strictObject({ name: z.string().max(120).optional(), conditions: Nodes(depth), logic: z.enum(['AND', 'OR']).optional(), action: ActionSchema.optional(), actions: z.array(ActionSchema).max(10).optional() }))
      .min(1)
      .max(50),
    schedule: z.enum(SCHEDULES).optional(),
    enabled: z.boolean().optional(),
  })

// ---- the remaining collections ---------------------------------------------------------------------------------

export const CUSTOM_FIELD_TYPES = ['number', 'currency', 'percentage', 'shortText', 'date', 'yesNo', 'dropdown'] as const
export interface CustomFieldBody {
  type: 'custom_field'
  entity: string
  name: string
  label?: string
  field_type: (typeof CUSTOM_FIELD_TYPES)[number]
  options?: string[]
  currency?: string
  precision?: number
  calculated?: boolean
  sensitive?: boolean
  enabled?: boolean
}
const customFieldBody = z.strictObject({
  type: z.literal('custom_field'),
  entity: Ref,
  name: z.string().min(1).max(64),
  label: z.string().max(120).optional(),
  field_type: z.enum(CUSTOM_FIELD_TYPES),
  options: z.array(z.string().max(80)).max(30).optional(),
  currency: z.string().max(3).optional(),
  precision: z.number().int().min(0).max(12).optional(),
  calculated: z.boolean().optional(),
  sensitive: z.boolean().optional(),
  enabled: z.boolean().optional(),
})

export interface AutomationBody {
  type: 'automation'
  name: string
  entity: string
  trigger?: Trigger
  steps: { kind: 'calculation' | 'rule' | 'workflow'; ref: string }[]
  enabled?: boolean
}
const automationBody = z.strictObject({
  type: z.literal('automation'),
  name: z.string().min(1).max(120),
  entity: Ref,
  trigger: z.enum(TRIGGERS).optional(),
  steps: z.array(z.strictObject({ kind: z.enum(['calculation', 'rule', 'workflow']), ref: Ref })).min(1).max(20),
  enabled: z.boolean().optional(),
})

export interface FilterBody {
  type: 'filter'
  name: string
  entity: string
  filters: ConditionNode[]
  enabled?: boolean
}
const filterBody = (depth: number) => z.strictObject({ type: z.literal('filter'), name: z.string().min(1).max(120), entity: Ref, filters: Nodes(depth), enabled: z.boolean().optional() })

export interface PermissionBody {
  type: 'permission'
  role_id: string
  area: PermissionArea
  /** false denies the area even when the role would otherwise allow it; true never grants more than the role already has */
  allow: boolean
  enabled?: boolean
}
const permissionBody = z.strictObject({ type: z.literal('permission'), role_id: Ref, area: z.enum(PERMISSION_AREAS), allow: z.boolean(), enabled: z.boolean().optional() })

// ---- dashboards ------------------------------------------------------------------------------------------------

export interface WidgetSource {
  entity?: string
  field?: string
  aggregation?: Aggregation
  filters?: ConditionNode[]
  groupBy?: string
  dateField?: string
  dateRange?: DateRangeSpec
  /** profit_loss: the expense field (income is `field`) */
  expenseField?: string
}
export interface WidgetFormat {
  kind: 'number' | 'currency' | 'percent'
  precision?: number
  currency?: string
}
export interface DashboardWidgetShape {
  id: string
  type: WidgetKind
  title: string
  /** a data source ... */
  source?: WidgetSource
  /** ... or a saved calculation (id / name) or an inline aggregate calculation */
  calculation?: string | CalculationBody
  enabled?: boolean
  /** w: columns 1-4, h: rows 1-3, order: position in the grid */
  layout: { w: number; h: number; order: number }
  format?: WidgetFormat
  limit?: number
  target?: number
  definition?: string
  /** how the card looks: a design variant and an accent colour (never changes the numbers) */
  style?: WidgetStyle
}

export const WIDGET_VARIANTS = ['minimal', 'icon', 'trend', 'smooth', 'step', 'area', 'vertical', 'horizontal', 'rounded', 'ring', 'thin', 'pie', 'bar', 'circular', 'segmented', 'compact', 'stacked', 'colorcoded'] as const
export type WidgetVariant = (typeof WIDGET_VARIANTS)[number]
export interface WidgetStyle {
  variant?: WidgetVariant
  /** #rrggbb */
  color?: string
}

const widgetSource = (depth: number) =>
  z.strictObject({
    entity: Ref.optional(),
    field: Ref.optional(),
    aggregation: z.enum(AGGREGATIONS).optional(),
    filters: Nodes(depth).optional(),
    groupBy: Ref.optional(),
    dateField: Ref.optional(),
    dateRange: DateRangeSchema.optional(),
    expenseField: Ref.optional(),
  })
const widgetShape = (depth: number) =>
  z.strictObject({
    id: Ref,
    type: z.enum(WIDGET_KINDS),
    title: z.string().min(1).max(120),
    source: widgetSource(Math.min(depth, 3)).optional(),
    calculation: z.union([Ref, calculationBody(Math.min(depth, 2))]).optional(),
    enabled: z.boolean().optional(),
    layout: z.strictObject({ w: z.number().int().min(1).max(4), h: z.number().int().min(1).max(3), order: z.number().int().min(0).max(1000) }),
    format: z.strictObject({ kind: z.enum(['number', 'currency', 'percent']), precision: z.number().int().min(0).max(8).optional(), currency: z.string().max(3).optional() }).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    target: z.number().optional(),
    definition: z.string().max(300).optional(),
    style: z.strictObject({ variant: z.enum(WIDGET_VARIANTS).optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() }).optional(),
  })

export interface DashboardBody {
  type: 'dashboard'
  name: string
  /** 'workspace': the shared default of a project. 'user': the layout of `userId` */
  scope?: 'workspace' | 'user'
  userId?: string
  /** the dashboard a user copy was forked from */
  baseId?: string
  isDefault?: boolean
  /** an auto-built default that is rebuilt from the project's modules until somebody edits it */
  autoManaged?: boolean
  widgets: DashboardWidgetShape[]
  enabled?: boolean
}
const dashboardBody = (depth: number) =>
  z.strictObject({
    type: z.literal('dashboard'),
    name: z.string().min(1).max(120),
    scope: z.enum(['workspace', 'user']).optional(),
    userId: z.string().max(80).optional(),
    baseId: z.string().max(80).optional(),
    isDefault: z.boolean().optional(),
    autoManaged: z.boolean().optional(),
    widgets: z.array(widgetShape(depth)).max(60),
    enabled: z.boolean().optional(),
  })

export interface DashboardWidgetItemBody {
  type: 'dashboard_widget'
  name: string
  widget: DashboardWidgetShape
  enabled?: boolean
}
const dashboardWidgetBody = (depth: number) => z.strictObject({ type: z.literal('dashboard_widget'), name: z.string().min(1).max(120), widget: widgetShape(depth), enabled: z.boolean().optional() })

// ---- stored items ----------------------------------------------------------------------------------------------

export interface ConfigMeta {
  id: string
  version: number
  enabled: boolean
  createdAt: string
  updatedAt: string
  ownerId: string
  workspaceId: string
}
export const META_KEYS = ['id', 'version', 'enabled', 'createdAt', 'updatedAt', 'ownerId', 'workspaceId'] as const
const metaShape = {
  id: z.string().min(1).max(80),
  version: z.number().int().min(1),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  ownerId: z.string(),
  workspaceId: z.string(),
}

export type Calculation = CalculationBody & ConfigMeta
export type ConditionalRule = ConditionalRuleBody & ConfigMeta
export type CustomField = CustomFieldBody & ConfigMeta
export type Automation = AutomationBody & ConfigMeta
export type SavedFilter = FilterBody & ConfigMeta
export type PermissionRule = PermissionBody & ConfigMeta
export type EngineDashboard = DashboardBody & ConfigMeta
export type DashboardWidgetItem = DashboardWidgetItemBody & ConfigMeta

export interface ItemOf {
  calculations: Calculation
  conditional_rules: ConditionalRule
  custom_fields: CustomField
  automations: Automation
  dashboards: EngineDashboard
  dashboard_widgets: DashboardWidgetItem
  filters: SavedFilter
  permissions: PermissionRule
}
export interface BodyOf {
  calculations: CalculationBody
  conditional_rules: ConditionalRuleBody
  custom_fields: CustomFieldBody
  automations: AutomationBody
  dashboards: DashboardBody
  dashboard_widgets: DashboardWidgetItemBody
  filters: FilterBody
  permissions: PermissionBody
}
export type AnyItem = ItemOf[ConfigKind]
export type AnyBody = BodyOf[ConfigKind]

function makeSchemas(depth: number) {
  const calc = calculationBody(depth)
  const rule = conditionalRuleBody(depth)
  const dash = dashboardBody(depth)
  const widget = dashboardWidgetBody(depth)
  const filt = filterBody(depth)
  return {
    bodies: {
      calculations: calc as unknown as z.ZodType<CalculationBody>,
      conditional_rules: rule as unknown as z.ZodType<ConditionalRuleBody>,
      custom_fields: customFieldBody as unknown as z.ZodType<CustomFieldBody>,
      automations: automationBody as unknown as z.ZodType<AutomationBody>,
      dashboards: dash as unknown as z.ZodType<DashboardBody>,
      dashboard_widgets: widget as unknown as z.ZodType<DashboardWidgetItemBody>,
      filters: filt as unknown as z.ZodType<FilterBody>,
      permissions: permissionBody as unknown as z.ZodType<PermissionBody>,
    },
    items: {
      calculations: calc.extend(metaShape) as unknown as z.ZodType<Calculation>,
      conditional_rules: rule.extend(metaShape) as unknown as z.ZodType<ConditionalRule>,
      custom_fields: customFieldBody.extend(metaShape) as unknown as z.ZodType<CustomField>,
      automations: automationBody.extend(metaShape) as unknown as z.ZodType<Automation>,
      dashboards: dash.extend(metaShape) as unknown as z.ZodType<EngineDashboard>,
      dashboard_widgets: widget.extend(metaShape) as unknown as z.ZodType<DashboardWidgetItem>,
      filters: filt.extend(metaShape) as unknown as z.ZodType<SavedFilter>,
      permissions: permissionBody.extend(metaShape) as unknown as z.ZodType<PermissionRule>,
    },
  }
}

const cache = new Map<number, ReturnType<typeof makeSchemas>>()
/** Schemas for a nesting depth. Depth 6 is used for validation; a smaller depth can feed a model's strict JSON schema. */
export const schemasFor = (depth: number) => {
  let s = cache.get(depth)
  if (!s) cache.set(depth, (s = makeSchemas(depth)))
  return s
}
export const SCHEMAS = schemasFor(6)

// ---- workspace document ----------------------------------------------------------------------------------------

export interface EngineDoc {
  /** the workspace this document belongs to (also its id in the stored list) */
  id: string
  v: 1
  calculations: Calculation[]
  conditional_rules: ConditionalRule[]
  custom_fields: CustomField[]
  automations: Automation[]
  dashboards: EngineDashboard[]
  dashboard_widgets: DashboardWidgetItem[]
  filters: SavedFilter[]
  permissions: PermissionRule[]
  /** legacy (pre-engine) dashboard ids that were already copied into `dashboards`, so a deleted copy never reappears */
  adoptedDashboardIds: string[]
  /** last scheduled run per config id (ISO), so a reload does not repeat an hourly/daily run */
  lastScheduledRun: Record<string, string>
}

export const emptyDoc = (workspaceId: string): EngineDoc => ({
  id: workspaceId,
  v: 1,
  calculations: [],
  conditional_rules: [],
  custom_fields: [],
  automations: [],
  dashboards: [],
  dashboard_widgets: [],
  filters: [],
  permissions: [],
  adoptedDashboardIds: [],
  lastScheduledRun: {},
})

/** Read a persisted document defensively: unknown or malformed collections become empty lists, never an exception. */
export function normalizeDoc(raw: unknown, fallbackId = ''): EngineDoc {
  const base = emptyDoc(typeof (raw as { id?: unknown })?.id === 'string' ? (raw as { id: string }).id : fallbackId)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base
  const r = raw as Record<string, unknown>
  const out: EngineDoc = { ...base }
  for (const k of CONFIG_KINDS) {
    const list = r[k]
    ;(out as unknown as Record<string, unknown>)[k] = Array.isArray(list) ? list.filter((x) => x && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string') : []
  }
  out.adoptedDashboardIds = Array.isArray(r.adoptedDashboardIds) ? r.adoptedDashboardIds.filter((x): x is string => typeof x === 'string') : []
  out.lastScheduledRun = r.lastScheduledRun && typeof r.lastScheduledRun === 'object' && !Array.isArray(r.lastScheduledRun) ? (r.lastScheduledRun as Record<string, string>) : {}
  return out
}
