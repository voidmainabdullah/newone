import { beforeEach, describe, expect, it } from 'vitest'
import { runCalculation } from '#/engine/calc'
import { evaluateRule, paymentStatusRule } from '#/engine/rules'
import { parseNl, nameScore } from '#/engine/nl'
import { configureShape } from '#/engine/nlIntent'
import { computeEngineWidget } from '#/engine/widgets'
import type { CalculationBody, ConditionalRuleBody, DashboardBody } from '#/engine/schema'
import { parseIntent } from '#/genius/ai/intent-parser'
import { useRecordStore } from '#/stores/recordStore'
import { envOf, putModules } from './engine-fixtures'
import { resetWorld } from './helpers'
import { draftOf, schoolModules, schoolRecords } from './engine-nl-fixtures'

const modules = schoolModules()
beforeEach(() => {
  resetWorld()
  putModules(...schoolModules())
  useRecordStore.getState().setAll(schoolRecords())
})

const env = () => envOf(modules, schoolRecords())
const num = (v: unknown) => (v && typeof v === 'object' && 'toNumber' in v ? (v as { toNumber(): number }).toNumber() : v)

describe('names are matched against the real schema (fuzzy, never invented)', () => {
  it('scores exact, singular, partial, synonym and typo matches', () => {
    expect(nameScore('paid amount', 'Paid amount')).toBe(100)
    expect(nameScore('paid_amount', 'paid amount')).toBe(100)
    expect(nameScore('fees', 'Fee')).toBe(100)
    expect(nameScore('paid', 'Paid amount')).toBeGreaterThanOrEqual(75)
    expect(nameScore('unpaid', 'Remaining amount')).toBe(62)
    expect(nameScore('atendance', 'Attendance')).toBe(60)
    expect(nameScore('banana', 'Paid amount')).toBe(0)
  })
  it('recognises the three request shapes (and leaves everything else to the other flows)', () => {
    expect(configureShape('Automatically calculate remaining amount by subtracting paid amount from total amount')).toBe('calculation')
    expect(configureShape('If paid amount is 0 then set payment status to Pending')).toBe('rule')
    expect(configureShape('Create a dashboard showing total students')).toBe('dashboard')
    for (const t of ['Add a phone number field to students', 'Remind the bursar when a fee is 3 days overdue', 'make fee status show Overdue after 30 days', 'How many students are in year 9?', 'Create a CRM for my school']) expect(configureShape(t)).toBeUndefined()
  })
  it('the Studio intent parser routes them as "configure" and keeps the existing intents', () => {
    const ctx = { hasModules: true, knownNames: ['Students', 'Fees'], hasVersions: true }
    expect(parseIntent('Automatically calculate remaining amount by subtracting paid amount from total amount', ctx).intent).toBe('configure')
    expect(parseIntent('If paid amount is 0 then set payment status to Pending', ctx).intent).toBe('configure')
    expect(parseIntent('Create a dashboard showing total students and average attendance', ctx).intent).toBe('configure')
    expect(parseIntent('Add a phone number field to students', ctx).intent).toBe('modify')
    expect(parseIntent('How many students are in year 9?', ctx).intent).toBe('question')
    expect(parseIntent('How is the outstanding balance calculated?', ctx).intent).toBe('explain_calculation')
    expect(parseIntent('delete the dashboard', ctx).intent).toBe('delete_or_deactivate')
    expect(parseIntent('Create a dashboard showing total students', { hasModules: false }).intent).not.toBe('configure') // nothing to configure yet
  })
})

describe('calculations from plain words', () => {
  const calc = (request: string) => draftOf(request, modules).body as CalculationBody

  it('subtracting A from B (order follows the words) and it computes on real records', () => {
    const body = calc('Automatically calculate remaining amount by subtracting paid amount from total amount')
    expect(body).toMatchObject({ type: 'calculation', entity: 'mod_fees', output_field: 'remaining_amount', operation: 'subtract', trigger: 'on_record_change' })
    expect(body.inputs).toEqual([{ field: 'total_amount', default: 0 }, { field: 'paid_amount', default: 0 }])
    const e = env()
    const out = e.records.filter((r) => r.moduleId === 'mod_fees').map((r) => num(runCalculation(body, e, { record: r }).value))
    expect(out).toEqual([0, 600, 500, 800])
  })

  it('A minus B, A plus B, A times B, A divided by B and the verb forms', () => {
    expect(calc('calculate remaining amount as total amount minus paid amount')).toMatchObject({ operation: 'subtract', inputs: [{ field: 'total_amount' }, { field: 'paid_amount' }] })
    expect(calc('calculate the remaining amount = total amount - paid amount')).toMatchObject({ operation: 'subtract' })
    expect(calc('calculate remaining amount by adding total amount and paid amount')).toMatchObject({ operation: 'add' })
    expect(calc('calculate remaining amount as total amount plus paid amount')).toMatchObject({ operation: 'add' })
    expect(calc('calculate remaining amount by multiplying total amount and paid amount')).toMatchObject({ operation: 'multiply' })
    expect(calc('calculate remaining amount as total amount times paid amount')).toMatchObject({ operation: 'multiply' })
    const div = calc('calculate remaining amount by dividing total amount by paid amount')
    expect(div).toMatchObject({ operation: 'divide', inputs: [{ field: 'total_amount' }, { field: 'paid_amount' }] })
    expect(calc('calculate remaining amount as total amount divided by paid amount')).toMatchObject({ operation: 'divide' })
    const times = calc('calculate remaining amount as total amount times 0.2')
    expect(times.inputs).toEqual([{ field: 'total_amount' }, { value: 0.2 }])
  })

  it('writes a regular field? No: it creates a new calculated one, and says so', () => {
    const res = draftOf('calculate paid amount as total amount minus remaining amount', modules)
    expect((res.body as CalculationBody).output_field).toBe('paid_amount_calculated')
    expect(res.assumptions.join(' ')).toContain('field people type into')
  })

  it('percentage of A out of B', () => {
    const res = draftOf('calculate paid percentage as percentage of paid amount out of total amount', modules)
    const body = res.body as CalculationBody
    expect(body).toMatchObject({ entity: 'mod_fees', operation: 'percentage', output_field: 'paid_percentage', output: { type: 'percentage' } })
    const e = env()
    const r = e.records.find((x) => x.id === 'f2')!
    expect(num(runCalculation(body, e, { record: r }).value)).toBe(40)
    // no name given: it asks what to call the result instead of inventing one
    const ask = parseNl('Calculate the percentage of paid amount out of total amount', modules)
    expect(ask).toMatchObject({ kind: 'clarify', options: ['Percentage'] })
    const named = parseNl('Calculate the percentage of paid amount out of total amount', modules, { answers: { [ask.kind === 'clarify' ? ask.id : '']: 'Percentage' } })
    expect(named.kind === 'draft' && named.body).toMatchObject({ operation: 'percentage', output_field: 'percentage' })
  })

  it('total / sum / count / average / min / max with a module, a filter and a period', () => {
    const e = env()
    const value = (body: CalculationBody) => num(runCalculation({ ...body }, e).value)
    const total = calc('calculate the total of paid amount in fees')
    expect(total).toMatchObject({ scope: 'aggregate', operation: 'sum', entity: 'mod_fees', inputs: [{ field: 'paid_amount' }] })
    expect(value(total)).toBe(1400)
    expect(value(calc('calculate the average total amount in fees'))).toBe(825)
    expect(value(calc('calculate the maximum total amount in fees'))).toBe(1000)
    expect(value(calc('calculate the minimum total amount in fees'))).toBe(500)
    expect(value(calc('calculate the count of fees'))).toBe(4)
    const filtered = calc('calculate the total of total amount in fees where payment status is pending')
    expect(filtered.filters).toEqual([{ field: 'payment_status', operator: 'equal', value: 'Pending' }])
    expect(value(filtered)).toBe(1300)
    const cond2 = calc('calculate the total of total amount in fees where payment status is pending and total amount is greater than 600')
    expect(value(cond2)).toBe(800)
    const either = calc('calculate the count of fees where payment status is paid or payment status is partial')
    expect(value(either)).toBe(2)
    const period = calc('calculate the total of paid amount in fees this month')
    expect(period.dateRange).toEqual({ preset: 'this_month', field: 'due_date' }) // the only date field of Fees
    const last30 = calc('calculate the count of fees in the last 30 days')
    expect(last30.dateRange).toEqual({ preset: 'last_30_days', field: 'due_date' })
    expect(calc('calculate the total of paid amount in fees this year').dateRange).toMatchObject({ preset: 'this_year' })
  })
})

describe('rules from plain words', () => {
  const rule = (request: string) => draftOf(request, modules).body as ConditionalRuleBody

  it('If <field comparison> then set <field> to <value>', () => {
    const body = rule('If paid amount is greater than 0 then set payment status to Partial')
    expect(body).toMatchObject({ type: 'conditional_rule', entity: 'mod_fees', trigger: 'on_record_change' })
    expect(body.rules).toHaveLength(1)
    expect(body.rules[0].conditions).toEqual([{ field: 'paid_amount', operator: 'greater_than', value: 0 }])
    expect(body.rules[0].action).toEqual({ type: 'set_status', field: 'payment_status', value: 'Partial' })
  })

  it('field-to-field comparison and "and" / "or" with a shared subject', () => {
    const a = rule('If paid amount is greater than or equal to total amount then set payment status to Paid')
    expect(a.rules[0].conditions).toEqual([{ field: 'paid_amount', operator: 'greater_than_or_equal', value: { field: 'total_amount' } }])
    const and = rule('If paid amount is greater than 0 and less than total amount then set payment status to Partial')
    expect(and.rules[0].logic).toBe('AND')
    expect(and.rules[0].conditions).toEqual([{ field: 'paid_amount', operator: 'greater_than', value: 0 }, { field: 'paid_amount', operator: 'less_than', value: { field: 'total_amount' } }])
    const or = rule('If paid amount is empty or paid amount is 0 then set payment status to Pending')
    expect(or.rules[0].logic).toBe('OR')
    expect(or.rules[0].conditions).toHaveLength(2)
    expect(or.rules[0].conditions[0]).toEqual({ field: 'paid_amount', operator: 'is_empty' })
    const mixed = rule('If payment status is Pending and total amount is more than 600 or paid amount is empty then set payment status to Partial')
    expect(mixed.rules[0].logic).toBe('OR')
    expect(mixed.rules[0].conditions[0]).toMatchObject({ logic: 'AND' })
  })

  it('"otherwise" / "else" and several actions', () => {
    const body = rule('If paid amount is greater than 0 then set payment status to Partial, otherwise set payment status to Pending')
    expect(body.rules.map((r) => r.name)).toEqual(['Partial', 'Otherwise'])
    expect(body.mode).toBe('first_match')
    const multi = rule('If payment status is Paid then set payment status to Paid and set notes to done')
    expect(multi.rules[0].actions).toHaveLength(2)
  })

  it('multi-branch Paid / Partial / Pending behaves like the reference rule on real records', () => {
    const res = draftOf('If paid amount is greater than or equal to total amount then set payment status to Paid. If paid amount is greater than 0 and less than total amount then set payment status to Partial. Otherwise set payment status to Pending.', modules)
    const body = res.body as ConditionalRuleBody
    expect(body.rules.map((r) => (r.action as { value: string }).value)).toEqual(['Paid', 'Partial', 'Pending'])
    expect(body.mode).toBe('first_match')
    const e = env()
    const ref = paymentStatusRule('mod_fees')
    const fees = modules[1]
    const writes = (rule: ConditionalRuleBody, record: (typeof e.records)[number]) => evaluateRule(rule, { module: fees, record, env: e }).effects.map((x) => (x.kind === 'set' ? [x.fieldId, x.value] : x.kind))
    for (const r of e.records.filter((x) => x.moduleId === 'mod_fees')) {
      expect(writes(body, r), r.id).toEqual(writes(ref, r))
      expect(writes(body, r), r.id).toHaveLength(1)
    }
    expect(res.assumptions.join(' ')).toContain('first matching rule wins')
  })

  it('else if / elif chains read the same way', () => {
    const body = rule('If paid amount is at least total amount then set payment status to Paid, else if paid amount is more than 0 then set payment status to Partial, else set payment status to Pending')
    expect(body.rules.map((r) => (r.action as { value: string }).value)).toEqual(['Paid', 'Partial', 'Pending'])
  })
})

describe('dashboards from plain words', () => {
  const REQUEST = 'create a dashboard showing total students, paid fees, unpaid fees, average attendance and students with attendance below 75%'
  it('five widgets, each a real config that computes the right number', () => {
    const res = draftOf(REQUEST, modules)
    const body = res.body as DashboardBody
    expect(body.widgets).toHaveLength(5)
    expect(body.widgets.map((w) => w.type)).toEqual(['record_count', 'kpi', 'kpi', 'average', 'record_count'])
    expect(body.widgets.map((w) => w.title)).toEqual(['Total students', 'Paid fees', 'Unpaid fees', 'Average attendance', 'Students with attendance below 75%'])
    expect(body.widgets[1].source).toMatchObject({ entity: 'mod_fees', field: 'paid_amount', aggregation: 'sum' })
    expect(body.widgets[2].source).toMatchObject({ entity: 'mod_fees', field: 'remaining_amount', aggregation: 'sum' })
    expect(body.widgets[4].source?.filters).toEqual([{ field: 'attendance', operator: 'less_than', value: 75 }])
    const e = env()
    // the calculated balance has not been computed in this fixture: give it stored values to read
    const withBalance = e.records.map((r) => (r.moduleId === 'mod_fees' ? { ...r, data: { ...r.data, remaining_amount: { f1: 0, f2: 600, f3: 500, f4: 800 }[r.id] } } : r))
    const live = envOf(modules, withBalance)
    const data = body.widgets.map((w) => computeEngineWidget(w, live))
    const values = data.map((d) => (d.kind === 'value' ? d.value : `unexpected ${d.kind}`))
    expect(values).toEqual([4, 1400, 1900, 75, 2])
  })

  it('a named dashboard with other phrasings', () => {
    const body = draftOf('Create a dashboard called Money showing the total of paid amount in fees and the number of payments', modules).body as DashboardBody
    expect(body.name).toBe('Money')
    expect(body.widgets).toHaveLength(2)
    expect(body.widgets[0]).toMatchObject({ type: 'kpi', source: { entity: 'mod_fees', field: 'paid_amount', aggregation: 'sum' } })
    expect(body.widgets[1]).toMatchObject({ type: 'record_count', source: { entity: 'mod_payments' } })
  })
})

describe('missing or ambiguous names become a question, never a guess', () => {
  it('an unknown field asks which real field was meant', () => {
    const res = parseNl('Automatically calculate remaining amount by subtracting discount from total amount', modules)
    expect(res.kind).toBe('clarify')
    if (res.kind !== 'clarify') return
    expect(res.question).toContain('“discount”')
    expect(res.options).toEqual(expect.arrayContaining(['total amount', 'paid amount']))
    expect(res.options.length).toBeGreaterThan(1)
    // answering it continues from where it stopped
    const again = parseNl('Automatically calculate remaining amount by subtracting discount from total amount', modules, { answers: { [res.id]: 'paid amount' } })
    expect(again.kind).toBe('draft')
    expect(again.kind === 'draft' && (again.body as CalculationBody).inputs).toEqual([{ field: 'total_amount', default: 0 }, { field: 'paid_amount', default: 0 }])
  })

  it('an unknown module, an unknown option and an unknown dashboard item all ask', () => {
    expect(parseNl('calculate the total of paid amount in invoices', modules)).toMatchObject({ kind: 'clarify', options: ['Students', 'Fees', 'Payments'] })
    const opt = parseNl('If paid amount is 0 then set payment status to Overdue', modules)
    expect(opt).toMatchObject({ kind: 'clarify', options: ['Paid', 'Partial', 'Pending'] })
    const dash = parseNl('create a dashboard showing total students and average salary', modules)
    expect(dash.kind).toBe('clarify')
    expect(dash.kind === 'clarify' && dash.question).toContain('“salary”')
  })

  it('two fields that match equally are never picked between', () => {
    const twin = schoolModules()
    twin[1].fields.push({ ...twin[1].fields[2], id: 'paid_on_account', name: 'paid_on_account', label: 'Paid on account' })
    const res = parseNl('Automatically calculate remaining amount by subtracting paid from total amount', twin)
    expect(res.kind).toBe('clarify')
    expect(res.kind === 'clarify' && res.options).toEqual(expect.arrayContaining(['paid amount', 'Paid on account']))
  })

  it('a field that exists in two modules asks which module', () => {
    const two = schoolModules()
    two[0].fields.push({ ...two[1].fields[2], id: 'paid_amount', name: 'paid_amount', label: 'Paid amount' })
    const res = parseNl('calculate the total of paid amount', two)
    expect(res).toMatchObject({ kind: 'clarify', options: ['Students', 'Fees'] })
    const picked = parseNl('calculate the total of paid amount', two, { answers: { [res.kind === 'clarify' ? res.id : '']: 'Fees' } })
    expect(picked.kind === 'draft' && (picked.body as CalculationBody).entity).toBe('mod_fees')
  })

  it('a text field where a number is needed is a question, not a bad config', () => {
    const res = parseNl('calculate the average of full name in students', modules)
    expect(res.kind).toBe('clarify')
  })

  it('not a configure request, or nothing to configure: no draft', () => {
    expect(parseNl('Add a notes field to students', modules).kind).toBe('none')
    expect(parseNl('calculate the total of paid amount in fees', []).kind).toBe('none')
  })
})
