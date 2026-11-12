import { describe, expect, it } from 'vitest'
import { runAggregate } from '#/engine/aggregate'
import { runCalculation, formatValue, scopeOf } from '#/engine/calc'
import { buildGraph, describeCycle, affectedNodes } from '#/engine/dependencies'
import { evaluateRule, evalCondition, paymentStatusRule } from '#/engine/rules'
import { parseBody } from '#/engine/items'
import { Decimal } from '#/genius/formula/decimal'
import type { CalculationBody, Calculation, Condition, ConditionalRule, ConditionalRuleBody, ConditionNode } from '#/engine/schema'
import { validateConfig, type ValidationEnv } from '#/engine/validate'
import { defaultRoles } from '#/services/storage/settingsStorage'
import { envOf, feesModule, field, mod, paymentsModule, rec, studentsModule } from './engine-fixtures'

const calc = (over: Partial<CalculationBody>): CalculationBody => ({ type: 'calculation', name: 'c', entity: 'mod_fees', operation: 'add', scope: 'record', output_field: 'out', ...over }) as CalculationBody
const fees = feesModule()
const r1 = rec('mod_fees', 'f1', { total_amount: 1000, paid_amount: 250, due_date: '2026-03-01' })
const run = (c: Partial<CalculationBody>, record = r1, extra = [r1]) => runCalculation(calc(c), envOf([fees], extra), { record }).value
const num = (v: unknown) => (v instanceof Decimal ? v.toString() : v)
const val = (n: number | string) => ({ value: n })
const fld = (f: string, d?: number) => ({ field: f, default: d })

describe('calculations: operations', () => {
  it('is exact: 0.1 + 0.2 = 0.3, no float drift', () => {
    expect(num(run({ operation: 'add', inputs: [val(0.1), val(0.2)] }))).toBe('0.3')
    expect(num(run({ operation: 'multiply', inputs: [val(0.1), val(3)] }))).toBe('0.3')
    expect(num(run({ operation: 'subtract', inputs: [val(0.3), val(0.1)] }))).toBe('0.2')
  })
  it('add, subtract, multiply, divide over fields', () => {
    expect(num(run({ operation: 'add', inputs: [fld('total_amount'), fld('paid_amount')] }))).toBe('1250')
    expect(num(run({ operation: 'subtract', inputs: [fld('total_amount'), fld('paid_amount')] }))).toBe('750')
    expect(num(run({ operation: 'multiply', inputs: [fld('total_amount'), val(2)] }))).toBe('2000')
    expect(num(run({ operation: 'divide', inputs: [fld('total_amount'), val(8)] }))).toBe('125')
    expect(num(run({ operation: 'divide', inputs: [val(1), val(3)], precision: 4 }))).toBe('0.3333')
  })
  it('percentage = part / whole * 100, percent_of = percent of a base', () => {
    expect(num(run({ operation: 'percentage', inputs: [fld('paid_amount'), fld('total_amount')] }))).toBe('25')
    expect(num(run({ operation: 'percent_of', inputs: [val(15), fld('total_amount')] }))).toBe('150')
  })
  it('average, min, max, count, sum over the inputs skip nulls', () => {
    const inputs = [val(2), fld('notes'), val(4), val(9)]
    expect(num(run({ operation: 'average', inputs }))).toBe('5')
    expect(num(run({ operation: 'min', inputs }))).toBe('2')
    expect(num(run({ operation: 'max', inputs }))).toBe('9')
    expect(num(run({ operation: 'count', inputs }))).toBe('3')
    expect(num(run({ operation: 'sum', inputs }))).toBe('15')
    expect(run({ operation: 'average', inputs: [fld('notes')] })).toBeNull()
    expect(num(run({ operation: 'sum', inputs: [fld('notes')] }))).toBe('0')
  })
  it('null propagates through arithmetic unless the input has a default', () => {
    const blank = rec('mod_fees', 'f2', { total_amount: 500 })
    expect(runCalculation(calc({ operation: 'subtract', inputs: [fld('total_amount'), fld('paid_amount')] }), envOf([fees], [blank]), { record: blank }).value).toBeNull()
    expect(num(runCalculation(calc({ operation: 'subtract', inputs: [fld('total_amount'), fld('paid_amount', 0)] }), envOf([fees], [blank]), { record: blank }).value)).toBe('500')
    expect(run({ operation: 'add', inputs: [fld('total_amount'), val('abc')] })).toBeNull()
  })
  it('division by zero is null, never Infinity or an exception', () => {
    expect(run({ operation: 'divide', inputs: [fld('total_amount'), val(0)] })).toBeNull()
    expect(run({ operation: 'percentage', inputs: [fld('paid_amount'), val(0)] })).toBeNull()
    expect(run({ operation: 'divide', inputs: [val(10), val(2), val(0)] })).toBeNull()
  })
  it('date_diff in days / weeks / months / years and date_add', () => {
    const d = (unit: 'days' | 'weeks' | 'months' | 'years') => num(run({ operation: 'date_diff', unit, inputs: [val('2026-01-15'), val('2027-03-20')] }))
    expect(d('days')).toBe('429')
    expect(d('weeks')).toBe('61')
    expect(d('months')).toBe('14')
    expect(d('years')).toBe('1')
    expect(num(run({ operation: 'date_diff', inputs: [fld('due_date'), val('today')] }))).toBe('14') // env.now = 2026-03-15
    expect(run({ operation: 'date_diff', inputs: [fld('notes'), val('today')] })).toBeNull()
    const added = run({ operation: 'date_add', unit: 'months', amount: 1, inputs: [fld('due_date')] })
    expect(added).toBeInstanceOf(Date)
    expect((added as Date).getMonth()).toBe(3)
  })
  it('compare returns -1, 0 or 1', () => {
    expect(num(run({ operation: 'compare', inputs: [fld('paid_amount'), fld('total_amount')] }))).toBe('-1')
    expect(num(run({ operation: 'compare', inputs: [val(5), val(5)] }))).toBe('0')
    expect(num(run({ operation: 'compare', inputs: [val('2026-05-01'), val('2026-01-01')] }))).toBe('1')
  })
  it('nested if / else', () => {
    const inner = { calc: { operation: 'if', condition: { field: 'paid_amount', operator: 'greater_than', value: 100 }, then: val(2), else: val(3) } } as const
    const c = { operation: 'if', condition: { field: 'total_amount', operator: 'greater_than_or_equal', value: 1000 }, then: inner, else: val(0) } as const
    expect(num(run(c as Partial<CalculationBody>))).toBe('2')
    const small = rec('mod_fees', 'f3', { total_amount: 10, paid_amount: 0 })
    expect(num(run(c as Partial<CalculationBody>, small, [small]))).toBe('0')
  })
  it('nested calc inputs: (total - paid) / total * 100', () => {
    const v = run({ operation: 'percentage', inputs: [{ calc: { operation: 'subtract', inputs: [fld('total_amount'), fld('paid_amount')] } }, fld('total_amount')] })
    expect(num(v)).toBe('75')
  })
  it('structural mistakes throw instead of silently producing a value', () => {
    expect(() => run({ operation: 'add', inputs: [fld('nope'), val(1)] })).toThrow(/Unknown field/)
    expect(() => run({ operation: 'count_if', inputs: [], filters: [{ field: 'total_amount', operator: 'greater_than', value: 1 }] })).toThrow(/aggregate/)
  })
  it('formats currency and percent with settings', () => {
    expect(formatValue(1234.5, { kind: 'currency', currency: 'USD' })).toBe('$1,234.50')
    expect(formatValue(45, { kind: 'percent', precision: 1 })).toBe('45.0%')
    expect(formatValue(null)).toBe('—')
  })
})

describe('calculations: aggregate scope and related records', () => {
  const m = mod('mod_fees', 'Fees', [field('total_amount', 'currency'), field('paid_amount', 'currency'), field('status', 'dropdown', { options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }), field('due_date', 'date')])
  const rows = [
    rec('mod_fees', 'a', { total_amount: 100.1, paid_amount: 0, status: 'a', due_date: '2026-03-02' }, { createdAt: '2026-03-02T09:00:00.000Z' }),
    rec('mod_fees', 'b', { total_amount: 200.2, paid_amount: 50, status: 'b', due_date: '2026-02-10' }, { createdAt: '2026-02-10T09:00:00.000Z' }),
    rec('mod_fees', 'c', { total_amount: 300.3, paid_amount: 300.3, status: 'a', due_date: '2026-03-10' }, { createdAt: '2026-03-10T09:00:00.000Z' }),
    rec('mod_fees', 'd', { total_amount: null, paid_amount: 10, status: 'b', due_date: '2025-12-31' }, { createdAt: '2025-12-31T09:00:00.000Z' }),
  ]
  const env = envOf([m], rows)
  const agg = (c: Partial<CalculationBody>) => runCalculation({ type: 'calculation', name: 'x', entity: 'mod_fees', scope: 'aggregate', operation: 'sum', ...c } as CalculationBody, env)
  it('sum is exact, average / min / max skip blanks', () => {
    expect(num(agg({ inputs: [fld('total_amount')] }).value)).toBe('600.6')
    expect(num(agg({ operation: 'average', inputs: [fld('total_amount')] }).value)).toBe('200.2')
    expect(num(agg({ operation: 'min', inputs: [fld('total_amount')] }).value)).toBe('100.1')
    expect(num(agg({ operation: 'max', inputs: [fld('total_amount')] }).value)).toBe('300.3')
    expect(num(agg({ operation: 'count' }).value)).toBe('4')
  })
  it('count_if / sum_if apply filters (incl. nested groups)', () => {
    expect(num(agg({ operation: 'count_if', filters: [{ field: 'status', operator: 'equal', value: 'a' }] }).value)).toBe('2')
    expect(num(agg({ operation: 'sum_if', inputs: [fld('total_amount')], filters: [{ logic: 'OR', conditions: [{ field: 'status', operator: 'equal', value: 'b' }, { field: 'paid_amount', operator: 'greater_than_or_equal', value: 300 }] }] }).value)).toBe('500.5')
  })
  it('groupBy returns a series, in option order', () => {
    const g = agg({ inputs: [fld('total_amount')], groupBy: 'status' })
    expect(g.groups?.map((x) => [x.label, num(x.value)])).toEqual([['A', '400.4'], ['B', '200.2']])
  })
  it('periods: presets, custom ranges and month buckets', () => {
    expect(num(agg({ operation: 'count', dateRange: { preset: 'this_month', field: 'due_date' } }).value)).toBe('2')
    expect(num(agg({ operation: 'count', dateRange: { preset: 'last_30_days', field: 'due_date' } }).value)).toBe('2')
    expect(num(agg({ operation: 'count', dateRange: { preset: 'custom', from: '2026-02-01', to: '2026-02-28', field: 'due_date' } }).value)).toBe('1')
    expect(num(agg({ operation: 'count', dateRange: 'this_year' }).value)).toBe('3')
    const series = agg({ operation: 'count', dateRange: { preset: 'all', bucket: 'month' } })
    expect(series.groups?.map((x) => [x.key, num(x.value)])).toEqual([['2025-12', '1'], ['2026-02', '1'], ['2026-03', '2']])
  })
  it('multi-record aggregation across related modules (both link directions)', () => {
    const students = studentsModule()
    const pay = paymentsModule()
    const s1 = rec('mod_students', 's1', { full_name: 'Ada' })
    const s2 = rec('mod_students', 's2', { full_name: 'Bo' })
    const p = [rec('mod_payments', 'p1', { student: ['s1'], amount: 10.1, method: 'cash' }), rec('mod_payments', 'p2', { student: ['s1'], amount: 20.2, method: 'card' }), rec('mod_payments', 'p3', { student: ['s2'], amount: 5 })]
    const e = envOf([students, pay], [s1, s2, ...p])
    const total = (ref: string) => runCalculation({ type: 'calculation', name: 't', entity: 'mod_students', output_field: 'total_paid', operation: 'sum', inputs: [fld('amount')], related: { entity: 'mod_payments', via: ref } } as CalculationBody, e, { record: s1 }).value
    expect(num(total('student'))).toBe('30.3')
    const cardOnly = runCalculation({ type: 'calculation', name: 't', entity: 'mod_students', output_field: 'x', operation: 'count_if', filters: [{ field: 'method', operator: 'equal', value: 'Card' }], related: { entity: 'mod_payments', via: 'student' } } as CalculationBody, e, { record: s1 }).value
    expect(num(cardOnly)).toBe('1')
    // forward direction: the student record lists its payments
    const studentsFwd = mod('mod_students', 'Students', [field('full_name', 'shortText'), field('payments', 'relationship', { relation: { moduleId: 'mod_payments', cardinality: 'one-to-many' } })])
    const sf = rec('mod_students', 's1', { payments: ['p1', 'p3'] })
    const ef = envOf([studentsFwd, pay], [sf, ...p])
    expect(num(runCalculation({ type: 'calculation', name: 't', entity: 'mod_students', output_field: 'x', operation: 'sum', inputs: [fld('amount')], related: { entity: 'mod_payments', via: 'payments' } } as CalculationBody, ef, { record: sf }).value)).toBe('15.1')
  })
  it('scope: an output field means per record, none means aggregate', () => {
    expect(scopeOf({ output_field: 'x' })).toBe('record')
    expect(scopeOf({})).toBe('aggregate')
    expect(scopeOf({ output_field: 'x', groupBy: 'status' })).toBe('aggregate')
  })
})

// ---- rules -----------------------------------------------------------------------------------------------------

const rm = mod('mod_r', 'Items', [
  field('n', 'number'),
  field('m', 'number'),
  field('name', 'shortText'),
  field('tags', 'multiSelect', { options: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }] }),
  field('stage', 'dropdown', { options: [{ id: 'new', label: 'New' }, { id: 'won', label: 'Won' }, { id: 'lost', label: 'Lost' }] }),
  field('active', 'yesNo'),
  field('when', 'date'),
])
const item = rec('mod_r', 'i1', { n: 5, m: 5, name: 'Hello World', tags: ['x'], stage: 'won', active: true, when: '2026-03-10' })
const ev = (c: Condition, record = item) => evalCondition(c, { module: rm, record, env: envOf([rm], [record]) })
const c = (field_: string, operator: Condition['operator'], value?: Condition['value']): Condition => ({ field: field_, operator, value })

describe('rules: every operator', () => {
  it('equal / not_equal (numbers, text, options by id or label)', () => {
    expect(ev(c('n', 'equal', 5))).toBe(true)
    expect(ev(c('n', 'equal', '5.0'))).toBe(true)
    expect(ev(c('n', 'not_equal', 6))).toBe(true)
    expect(ev(c('stage', 'equal', 'Won'))).toBe(true)
    expect(ev(c('stage', 'equal', 'won'))).toBe(true)
    expect(ev(c('stage', 'not_equal', 'Lost'))).toBe(true)
    expect(ev(c('name', 'equal', 'hello world'))).toBe(true)
  })
  it('greater / less (and or equal)', () => {
    expect(ev(c('n', 'greater_than', 4))).toBe(true)
    expect(ev(c('n', 'greater_than', 5))).toBe(false)
    expect(ev(c('n', 'greater_than_or_equal', 5))).toBe(true)
    expect(ev(c('n', 'less_than', 6))).toBe(true)
    expect(ev(c('n', 'less_than_or_equal', 5))).toBe(true)
    expect(ev(c('n', 'less_than', 5))).toBe(false)
  })
  it('contains / not_contains on text and multi values', () => {
    expect(ev(c('name', 'contains', 'world'))).toBe(true)
    expect(ev(c('name', 'not_contains', 'xyz'))).toBe(true)
    expect(ev(c('tags', 'contains', 'X'))).toBe(true)
    expect(ev(c('tags', 'not_contains', 'Y'))).toBe(true)
  })
  it('is_empty / is_not_empty: 0 and false are values', () => {
    const e = rec('mod_r', 'i2', { n: 0, name: '', tags: [], active: false })
    expect(ev(c('n', 'is_empty'), e)).toBe(false)
    expect(ev(c('m', 'is_empty'), e)).toBe(true)
    expect(ev(c('name', 'is_empty'), e)).toBe(true)
    expect(ev(c('tags', 'is_empty'), e)).toBe(true)
    expect(ev(c('active', 'is_empty'), e)).toBe(false)
    expect(ev(c('name', 'is_not_empty'))).toBe(true)
  })
  it('is_true / is_false', () => {
    expect(ev(c('active', 'is_true'))).toBe(true)
    expect(ev(c('active', 'is_false'))).toBe(false)
    expect(ev(c('active', 'is_false'), rec('mod_r', 'i3', {}))).toBe(true)
  })
  it('between is inclusive, numbers and dates', () => {
    expect(ev(c('n', 'between', [5, 10]))).toBe(true)
    expect(ev(c('n', 'between', [6, 10]))).toBe(false)
    expect(ev(c('when', 'between', ['2026-03-01', '2026-03-10']))).toBe(true)
    expect(ev(c('when', 'between', ['2026-03-11', '2026-03-20']))).toBe(false)
  })
  it('before / after with dates and "today" (now = 2026-03-15)', () => {
    expect(ev(c('when', 'before', '2026-03-11'))).toBe(true)
    expect(ev(c('when', 'after', '2026-03-10'))).toBe(false)
    expect(ev(c('when', 'before', 'today'))).toBe(true)
    expect(ev(c('when', 'after', '2026-03-01'))).toBe(true)
  })
  it('in / not_in', () => {
    expect(ev(c('stage', 'in', ['Won', 'Lost']))).toBe(true)
    expect(ev(c('stage', 'not_in', ['New', 'Lost']))).toBe(true)
    expect(ev(c('n', 'in', [1, 5]))).toBe(true)
    expect(ev(c('n', 'not_in', [5]))).toBe(false)
  })
  it('field-to-field comparisons', () => {
    expect(ev(c('n', 'equal', { field: 'm' }))).toBe(true)
    expect(ev(c('n', 'greater_than_or_equal', { field: 'm' }))).toBe(true)
    expect(ev(c('n', 'less_than', { field: 'm' }))).toBe(false)
    expect(ev(c('n', 'between', [{ field: 'm' }, 10]))).toBe(true)
  })
  it('blank values never satisfy ordering operators', () => {
    const e = rec('mod_r', 'i4', {})
    for (const op of ['greater_than', 'less_than', 'greater_than_or_equal', 'less_than_or_equal'] as const) expect(ev(c('n', op, 0), e)).toBe(false)
    expect(ev(c('n', 'not_equal', 0), e)).toBe(true)
  })
  it('an unknown field is an error, not a silent false', () => {
    expect(() => ev(c('ghost', 'equal', 1))).toThrow(/Unknown field/)
  })
})

describe('rules: nested logic, modes, actions', () => {
  const env = envOf([rm], [item])
  const rcx = { module: rm, record: item, env }
  const body = (mode: 'first_match' | 'all', rules: ConditionalRuleBody['rules']): ConditionalRuleBody => ({ type: 'conditional_rule', name: 'r', entity: 'mod_r', mode, rules })
  const set = (value: string) => ({ type: 'set_status' as const, field: 'stage', value })
  it('nested AND/OR groups', () => {
    const nested: ConditionNode[] = [c('n', 'equal', 5), { logic: 'OR', conditions: [c('stage', 'equal', 'Lost'), { logic: 'AND', conditions: [c('name', 'contains', 'hello'), c('active', 'is_true')] }] }]
    expect(evaluateRule(body('all', [{ conditions: nested, logic: 'AND', action: set('New') }]), rcx).matched).toEqual([0])
    const bad: ConditionNode[] = [c('n', 'equal', 5), { logic: 'OR', conditions: [c('stage', 'equal', 'Lost'), { logic: 'AND', conditions: [c('name', 'contains', 'hello'), c('active', 'is_false')] }] }]
    expect(evaluateRule(body('all', [{ conditions: bad, action: set('New') }]), rcx).matched).toEqual([])
    expect(evaluateRule(body('all', [{ conditions: [c('n', 'equal', 1), c('m', 'equal', 5)], logic: 'OR', action: set('New') }]), rcx).matched).toEqual([0])
  })
  it('first_match stops at the first rule that holds; all runs every match, later writes win', () => {
    const rules: ConditionalRuleBody['rules'] = [
      { conditions: [c('n', 'greater_than', 1)], action: set('New') },
      { conditions: [c('n', 'greater_than', 2)], actions: [set('Lost'), { type: 'update_field', field: 'm', value: 99 }] },
    ]
    const first = evaluateRule(body('first_match', rules), rcx)
    expect(first.matched).toEqual([0])
    expect(first.effects).toEqual([{ kind: 'set', fieldId: 'stage', value: 'new', rule: 0 }])
    const all = evaluateRule(body('all', rules), rcx)
    expect(all.matched).toEqual([0, 1])
    expect(all.effects).toEqual([{ kind: 'set', fieldId: 'stage', value: 'lost', rule: 1 }, { kind: 'set', fieldId: 'm', value: 99, rule: 1 }])
  })
  it('all four action kinds produce effects; an unknown option is refused', () => {
    const out = evaluateRule(body('all', [{ conditions: [], actions: [{ type: 'calculate', calculation: 'Remaining' }, { type: 'run_automation', workflow_id: 'wf_1' }, { type: 'update_field', field: 'name', value: { field: 'stage' } }] }]), rcx)
    expect(out.effects.map((e) => e.kind)).toEqual(['calculate', 'automation', 'set'])
    expect(() => evaluateRule(body('all', [{ conditions: [], action: set('Nope') }]), rcx)).toThrow(/not an option/)
  })
})

describe('Automatic Payment Status', () => {
  const rule = paymentStatusRule('mod_fees')
  const status = (data: Record<string, unknown>) => {
    const record = rec('mod_fees', 'p', data)
    const out = evaluateRule(rule, { module: fees, record, env: envOf([fees], [record]) })
    return out.effects.map((e) => (e.kind === 'set' ? e.value : null))
  }
  it('Paid when paid >= total (and total > 0)', () => {
    expect(status({ total_amount: 1000, paid_amount: 1000 })).toEqual(['paid'])
    expect(status({ total_amount: 1000, paid_amount: 1200 })).toEqual(['paid'])
  })
  it('Partial when 0 < paid < total', () => {
    expect(status({ total_amount: 1000, paid_amount: 0.01 })).toEqual(['partial'])
    expect(status({ total_amount: 1000, paid_amount: 999.99 })).toEqual(['partial'])
  })
  it('Pending when paid is empty or zero', () => {
    expect(status({ total_amount: 1000, paid_amount: 0 })).toEqual(['pending'])
    expect(status({ total_amount: 1000 })).toEqual(['pending'])
    expect(status({ total_amount: 0, paid_amount: 0 })).toEqual(['pending'])
    expect(status({})).toEqual(['pending'])
  })
  it('the rule JSON passes the strict schema and the semantic validator', () => {
    expect(parseBody(JSON.stringify(rule)).ok).toBe(true)
    expect(validateConfig(rule, venv()).ok).toBe(true)
  })
})

// ---- dependencies ----------------------------------------------------------------------------------------------

const asCalc = (b: CalculationBody, id: string): Calculation => ({ ...b, id, version: 1, enabled: true, createdAt: '', updatedAt: '', ownerId: 'u', workspaceId: 'ws_test', scope: b.scope ?? 'record' }) as Calculation
const asRule = (b: ConditionalRuleBody, id: string): ConditionalRule => ({ ...b, id, version: 1, enabled: true, createdAt: '', updatedAt: '', ownerId: 'u', workspaceId: 'ws_test' }) as ConditionalRule
const remaining = (): CalculationBody => calc({ name: 'Remaining', output_field: 'remaining_amount', operation: 'subtract', inputs: [fld('total_amount'), fld('paid_amount', 0)] })

describe('dependency graph', () => {
  it('orders producers before consumers whatever the saved order', () => {
    const percent = calc({ name: 'Percent left', output_field: 'pct_left', operation: 'percentage', inputs: [fld('remaining_amount'), fld('total_amount')] })
    const statusRule = paymentStatusRule('mod_fees')
    const g = buildGraph([{ kind: 'rule', config: asRule(statusRule, 'r') }, { kind: 'calculation', config: asCalc(percent, 'c2') }, { kind: 'calculation', config: asCalc(remaining(), 'c1') }], [feesModule()])
    expect(g.cycle).toBeNull()
    const order = g.order.map((n) => n.id)
    expect(order.indexOf('c1')).toBeLessThan(order.indexOf('c2'))
  })
  it('only configs that read a changed field are affected, and what they feed', () => {
    const late = calc({ name: 'Days late', output_field: 'days_late', operation: 'date_diff', inputs: [fld('due_date'), val('today')] })
    const rem = asCalc({ ...remaining() }, 'c1')
    const pct = asCalc(calc({ name: 'Pct', output_field: 'pct', operation: 'percentage', inputs: [fld('remaining_amount'), fld('total_amount')] }), 'c2')
    const g = buildGraph([{ kind: 'calculation', config: rem }, { kind: 'calculation', config: pct }, { kind: 'calculation', config: asCalc(late, 'c3') }], [feesModule()])
    expect(affectedNodes(g, new Set(['mod_fees.paid_amount'])).map((n) => n.id)).toEqual(['c1', 'c2'])
    expect(affectedNodes(g, new Set(['mod_fees.due_date'])).map((n) => n.id)).toEqual(['c3'])
    expect(affectedNodes(g, new Set(['mod_fees.notes']))).toEqual([])
  })
  it('detects a cycle and names it', () => {
    const a = calc({ name: 'A', output_field: 'a_out', operation: 'add', inputs: [fld('b_out'), val(1)] })
    const b = calc({ name: 'B', output_field: 'b_out', operation: 'add', inputs: [fld('a_out'), val(1)] })
    const g = buildGraph([{ kind: 'calculation', config: asCalc(a, 'a') }, { kind: 'calculation', config: asCalc(b, 'b') }], [feesModule()])
    expect(g.cycle).toEqual(['A', 'B', 'A'])
    expect(describeCycle(g.cycle!)).toContain('"A" → "B" → "A"')
    expect(g.order).toEqual([])
  })
})

// ---- validator -------------------------------------------------------------------------------------------------

function venv(over: Partial<ValidationEnv> = {}): ValidationEnv {
  return { modules: [feesModule(), studentsModule(), paymentsModule()], calculations: [], rules: [], ...over }
}
const errs = (input: unknown, env = venv()) => validateConfig(input, env).errors.map((e) => `${e.path}: ${e.message}`)

describe('validator', () => {
  it('accepts a good calculation', () => {
    const v = validateConfig(remaining(), venv())
    expect(v.errors).toEqual([])
    expect(v.ok).toBe(true)
  })
  it('rejects an unknown module and an unknown field', () => {
    expect(errs(calc({ entity: 'ghosts', inputs: [val(1), val(2)] })).join('\n')).toMatch(/Module "ghosts" does not exist/)
    expect(errs(remaining() && calc({ output_field: 'x', operation: 'add', inputs: [fld('nope'), val(1)] })).join('\n')).toMatch(/Field "nope" does not exist in "Fees"/)
  })
  it('rejects an operator that does not fit the field type', () => {
    const rule = (field_: string, operator: Condition['operator'], value?: Condition['value']): ConditionalRuleBody => ({ type: 'conditional_rule', name: 'r', entity: 'mod_fees', rules: [{ conditions: [{ field: field_, operator, value }], action: { type: 'update_field', field: 'notes', value: 'x' } }] })
    expect(errs(rule('total_amount', 'contains', 'x')).join('\n')).toMatch(/cannot be used on currency field/)
    expect(errs(rule('notes', 'greater_than', 3)).join('\n')).toMatch(/cannot be used on shortText field/)
    expect(errs(rule('notes', 'before', '2026-01-01')).join('\n')).toMatch(/cannot be used/)
    expect(errs(rule('total_amount', 'greater_than', 'abc')).join('\n')).toMatch(/not a number/)
    expect(errs(rule('total_amount', 'between', [1])).join('\n')).toMatch(/\[from, to\]/)
    expect(errs(rule('payment_status', 'equal', 'paid')).join('\n')).toBe('')
  })
  it('rejects numeric operations on text fields', () => {
    expect(errs(calc({ output_field: 'x', operation: 'add', inputs: [fld('notes'), val(1)] })).join('\n')).toMatch(/"notes" is a shortText field; "add" needs a number/)
    expect(errs(calc({ output_field: 'x', operation: 'date_diff', inputs: [fld('total_amount'), val('today')] })).join('\n')).toMatch(/needs a date field/)
  })
  it('rejects an output field that is also its own source', () => {
    expect(errs(calc({ output_field: 'remaining_amount', operation: 'subtract', inputs: [fld('total_amount'), fld('remaining_amount')] })).join('\n')).toMatch(/also an input/)
  })
  it('refuses to overwrite a field people type into', () => {
    expect(errs(calc({ output_field: 'paid_amount', operation: 'add', inputs: [val(1), val(2)] })).join('\n')).toMatch(/regular field/)
  })
  it('rejects a circular dependency at save time and names it', () => {
    const a = calc({ name: 'A', output_field: 'a_out', operation: 'add', inputs: [fld('b_out'), val(1)] })
    const b = calc({ name: 'B', output_field: 'b_out', operation: 'add', inputs: [fld('a_out'), val(1)] })
    const env = venv({ calculations: [asCalc(a, 'a')] })
    const out = validateConfig(b, env)
    expect(out.ok).toBe(false)
    expect(out.cycle).toHaveLength(3)
    expect(out.cycle![0]).toBe(out.cycle![2])
    expect(new Set(out.cycle)).toEqual(new Set(['A', 'B']))
    expect(out.errors[0].message).toContain('Circular dependency')
  })
  it('checks permissions with the existing permission keys', () => {
    const viewer = defaultRoles().find((r) => !r.permissions.manageFields)!
    const out = validateConfig(remaining(), venv({ role: viewer }))
    expect(out.ok).toBe(false)
    expect(out.errors[0].message).toMatch(/needs "manageFields"/)
    const owner = defaultRoles().find((r) => r.id === 'role_owner')!
    expect(validateConfig(remaining(), venv({ role: owner })).ok).toBe(true)
  })
  it('rejects bad JSON shapes with paths', () => {
    expect(errs('{ nope')[0]).toMatch(/Not valid JSON/)
    expect(errs({ type: 'calculation', name: 'x', entity: 'mod_fees', operation: 'power' })[0]).toMatch(/operation/)
    expect(errs({ type: 'banana' })[0]).toMatch(/type/)
  })
  it('validates widget sources', () => {
    const dash = (source: object, type = 'kpi') => ({ type: 'dashboard', name: 'D', widgets: [{ id: 'w1', type, title: 'T', source, layout: { w: 1, h: 1, order: 0 } }] })
    expect(errs(dash({ entity: 'mod_fees', field: 'total_amount', aggregation: 'sum' }))).toEqual([])
    expect(errs(dash({ entity: 'ghosts', aggregation: 'count' })).join('\n')).toMatch(/does not exist/)
    expect(errs(dash({ entity: 'mod_fees', field: 'notes', aggregation: 'sum' })).join('\n')).toMatch(/needs a number/)
    expect(errs(dash({ entity: 'mod_fees', dateField: 'notes', aggregation: 'count' }, 'record_count')).join('\n')).toMatch(/not a date field/)
  })
})

// ---- aggregation -----------------------------------------------------------------------------------------------

describe('aggregate()', () => {
  const m = mod('mod_s', 'Sales', [field('amount', 'currency'), field('region', 'dropdown', { options: [{ id: 'n', label: 'North' }, { id: 's', label: 'South' }] }), field('day', 'date')])
  const rows = [
    rec('mod_s', '1', { amount: 10.1, region: 'n', day: '2026-03-01' }),
    rec('mod_s', '2', { amount: 20.2, region: 's', day: '2026-03-05' }),
    rec('mod_s', '3', { amount: 0.1, region: 'n', day: '2026-02-20' }),
    rec('mod_s', '4', { amount: 0.2, region: 'n', day: '2026-02-21' }, { deletedAt: '2026-03-01T00:00:00.000Z' }),
    rec('mod_s', '5', { amount: 7, region: 's', day: '2025-11-02' }, { archived: true }),
  ]
  const env = envOf([m], rows)
  it('ignores deleted and archived records and sums exactly', () => {
    const r = runAggregate(env, { entity: 'mod_s', agg: 'sum', field: 'amount' })
    expect(r.value?.toString()).toBe('30.4')
    expect(r.count).toBe(3)
  })
  it('filters (engine conditions and legacy filters), together', () => {
    expect(runAggregate(env, { entity: 'mod_s', agg: 'sum', field: 'amount', filters: [{ field: 'region', operator: 'equal', value: 'North' }] }).value?.toString()).toBe('10.2')
    expect(runAggregate(env, { entity: 'Sales', agg: 'count', legacyFilters: [{ id: 'f', fieldId: 'amount', op: 'greater', value: 5 }] }).value?.toString()).toBe('2')
    expect(runAggregate(env, { entity: 'mod_s', agg: 'count', filters: [{ field: 'amount', operator: 'between', value: [1, 25] }, { field: 'region', operator: 'in', value: ['South'] }] }).value?.toString()).toBe('1')
  })
  it('date ranges: this_month, last_month, custom (now = 2026-03-15)', () => {
    const cnt = (dateRange: Parameters<typeof runAggregate>[1]['dateRange']) => runAggregate(env, { entity: 'mod_s', agg: 'count', dateField: 'day', dateRange }).count
    expect(cnt('this_month')).toBe(2)
    expect(cnt('last_month')).toBe(1)
    expect(cnt({ preset: 'custom', from: '2026-02-01', to: '2026-03-01' })).toBe(2)
    expect(cnt('last_7_days')).toBe(0)
    expect(cnt('last_30_days')).toBe(3)
    expect(cnt('all')).toBe(3)
  })
  it('groupBy and time buckets', () => {
    const g = runAggregate(env, { entity: 'mod_s', agg: 'sum', field: 'amount', groupBy: 'region' })
    expect(g.groups.map((x) => [x.label, x.value?.toString(), x.count])).toEqual([['North', '10.2', 2], ['South', '20.2', 1]])
    const t = runAggregate(env, { entity: 'mod_s', agg: 'count', dateField: 'day', bucket: 'month' })
    expect(t.groups.map((x) => [x.key, x.count])).toEqual([['2026-02', 1], ['2026-03', 2]])
  })
  it('is memoised per records array and query', () => {
    const q = { entity: 'mod_s', agg: 'sum' as const, field: 'amount' }
    expect(runAggregate(env, q)).toBe(runAggregate(env, q))
    expect(runAggregate(env, { ...q, agg: 'max' })).not.toBe(runAggregate(env, q))
  })
})
