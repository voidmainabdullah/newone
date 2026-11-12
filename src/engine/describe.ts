import type { Module } from '#/types'
import { resolveField, resolveModule } from './resolve'
import { isGroup, type Action, type CalculationBody, type ConditionNode, type ConditionalRuleBody, type DashboardBody, type DateRangeSpec, type Input, type OperandValue, type Operator } from './schema'

/**
 * A configuration in plain words, using the project's own module and field names. Pure: the Studio card, the chat and the
 * tests all read the same sentences.
 */

const OP_TEXT: Record<Operator, string> = {
  equal: 'is', not_equal: 'is not', greater_than: 'is greater than', less_than: 'is less than', greater_than_or_equal: 'is at least', less_than_or_equal: 'is at most',
  contains: 'contains', not_contains: 'does not contain', is_empty: 'is empty', is_not_empty: 'is not empty', is_true: 'is yes', is_false: 'is no',
  between: 'is between', before: 'is before', after: 'is after', in: 'is one of', not_in: 'is none of',
}
const NO_VALUE = new Set<Operator>(['is_empty', 'is_not_empty', 'is_true', 'is_false'])
const PERIOD: Record<string, string> = { all: 'all time', today: 'today', this_week: 'this week', this_month: 'this month', last_month: 'last month', last_7_days: 'the last 7 days', last_30_days: 'the last 30 days', last_90_days: 'the last 90 days', this_year: 'this year', custom: 'a custom period' }

const labelIn = (m: Module | undefined, ref: string): string => (m ? resolveField(m, ref)?.label : undefined) ?? ref

function operandText(m: Module | undefined, v: OperandValue | undefined): string {
  if (v === undefined || v === null) return ''
  if (Array.isArray(v)) return v.map((x) => operandText(m, x)).join(' and ')
  if (typeof v === 'object') return labelIn(m, v.field)
  return typeof v === 'string' ? `“${v}”` : String(v)
}

export function conditionText(m: Module | undefined, node: ConditionNode): string {
  if (isGroup(node)) {
    const join = node.logic === 'OR' ? ' or ' : ' and '
    const parts = node.conditions.map((c) => conditionText(m, c))
    return parts.length > 1 ? `(${parts.join(join)})` : (parts[0] ?? '')
  }
  const value = NO_VALUE.has(node.operator) ? '' : ` ${operandText(m, node.value)}`
  return `${labelIn(m, node.field)} ${OP_TEXT[node.operator]}${value}`.trim()
}

export const conditionsText = (m: Module | undefined, nodes: ConditionNode[], logic: 'AND' | 'OR' = 'AND'): string => nodes.map((n) => conditionText(m, n)).join(logic === 'OR' ? ' or ' : ' and ')

/** "Otherwise" is written as an always-true pair of conditions on one field; say so instead of printing the pair. */
const isOtherwise = (nodes: ConditionNode[], logic: 'AND' | 'OR' | undefined): boolean => {
  if (logic !== 'OR' || nodes.length !== 2) return false
  const [a, b] = nodes
  return !isGroup(a) && !isGroup(b) && a.field === b.field && ((a.operator === 'is_empty' && b.operator === 'is_not_empty') || (a.operator === 'is_not_empty' && b.operator === 'is_empty'))
}

export function actionText(m: Module | undefined, a: Action): string {
  if (a.type === 'set_status') return `set ${a.field ? labelIn(m, a.field) : 'the status'} to “${a.value}”`
  if (a.type === 'update_field') return `set ${labelIn(m, a.field)} to ${operandText(m, a.value as OperandValue)}`
  if (a.type === 'calculate') return `run the calculation ${a.calculation}`
  return `run the workflow ${a.workflow_id}`
}

const rangeText = (r: DateRangeSpec | undefined): string => (r ? (typeof r === 'string' ? PERIOD[r] : PERIOD[r.preset]) ?? '' : '')
const inputText = (m: Module | undefined, i: Input): string => ('field' in i ? labelIn(m, i.field) : 'value' in i ? String(i.value) : 'a calculation')

export interface Described {
  /** short heading: "Calculation in Fees" */
  title: string
  /** what it does, one plain line each */
  lines: string[]
  /** where the result lives */
  where?: string
}

export function describeCalculation(body: CalculationBody, modules: Module[]): Described {
  const m = resolveModule(modules, body.entity)
  const names = (body.inputs ?? []).map((i) => inputText(m, i))
  const out = body.output?.label ?? (body.output_field ? labelIn(m, body.output_field) : undefined)
  if (body.scope === 'aggregate') {
    const what = body.operation === 'count' ? `the number of ${m?.name ?? body.entity} records` : `the ${body.operation === 'sum' ? 'total' : body.operation} of ${names[0] ?? 'a field'} in ${m?.name ?? body.entity}`
    const lines = [`Works out ${what}.`]
    if (body.filters?.length) lines.push(`Only where ${conditionsText(m, body.filters)}.`)
    const period = rangeText(body.dateRange)
    if (period) lines.push(`For ${period}.`)
    return { title: `Calculation in ${m?.name ?? body.entity}`, lines, where: 'A value you can show on a dashboard (nothing is written to records).' }
  }
  const sym: Record<string, string> = { add: ' + ', subtract: ' − ', multiply: ' × ', divide: ' ÷ ' }
  const formula = body.operation === 'percentage' ? `${names[0]} as a percentage of ${names[1]}` : (names.join(sym[body.operation] ?? ', ') || body.operation)
  const lines = [`${out ?? 'The result'} = ${formula}`]
  if ((body.inputs ?? []).some((i) => 'field' in i && i.default !== undefined)) lines.push('A blank value counts as 0.')
  lines.push(body.trigger === 'manual' ? 'Runs when you ask it to.' : body.trigger === 'schedule' ? 'Runs on a schedule.' : 'Recalculated whenever a record changes.')
  return { title: `Calculation in ${m?.name ?? body.entity}`, lines, where: out ? `Saved in ${m?.name ?? body.entity} → ${out}` : undefined }
}

export function describeRule(body: ConditionalRuleBody, modules: Module[]): Described {
  const m = resolveModule(modules, body.entity)
  const lines = body.rules.map((r) => {
    const actions = (r.actions ?? (r.action ? [r.action] : [])).map((a) => actionText(m, a)).join(' and ')
    return isOtherwise(r.conditions, r.logic) ? `Otherwise → ${actions}` : `If ${conditionsText(m, r.conditions, r.logic)} → ${actions}`
  })
  return { title: `Rule in ${m?.name ?? body.entity}`, lines, where: body.rules.length > 1 ? `The first matching rule wins, in this order.` : undefined }
}

export function describeDashboard(body: DashboardBody, modules: Module[]): Described {
  const lines = [...body.widgets].sort((a, b) => a.layout.order - b.layout.order).map((w) => {
    const m = w.source?.entity ? resolveModule(modules, w.source.entity) : undefined
    const f = w.source?.field ? labelIn(m, w.source.field) : undefined
    const agg = w.source?.aggregation
    const what = agg === 'count' || !f ? `number of ${m?.name ?? 'records'}` : `${agg === 'sum' ? 'total' : agg} of ${f}`
    const cond = w.source?.filters?.length ? ` where ${conditionsText(m, w.source.filters)}` : ''
    return `${w.title}: ${what}${cond}`
  })
  return { title: `Dashboard “${body.name}”`, lines, where: 'Saved as your own dashboard (only you see it).' }
}

export const describeConfig = (body: CalculationBody | ConditionalRuleBody | DashboardBody, modules: Module[]): Described => (body.type === 'calculation' ? describeCalculation(body, modules) : body.type === 'conditional_rule' ? describeRule(body, modules) : describeDashboard(body, modules))
