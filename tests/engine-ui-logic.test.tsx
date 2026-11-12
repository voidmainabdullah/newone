import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { InlineField, controlFor as controlForFromComponent } from '#/components/fields/InlineField'
import { commitInline, confirmMessage, controlFor, editableState, parseInlineValue, toggleValues, type CommitDeps } from '#/components/fields/inlineEdit'
import { blankCalculation, blankRule, checkJson, dependencyInfo, previewConfig, summarize, toJson } from '#/engine/editing'
import { startEngine, stopEngine } from '#/engine/runtime'
import { paymentStatusRule } from '#/engine/rules'
import { saveConfig } from '#/engine/service'
import { useModuleStore } from '#/stores/moduleStore'
import { useRecordStore } from '#/stores/recordStore'
import { makeCtx } from '#/utils/records'
import type { Field } from '#/types'
import { dataOf, feesModule, field, mod, putModules } from './engine-fixtures'
import { resetWorld, roleById, WS } from './helpers'

// zustand hooks read their INITIAL state during server rendering, so the permission hook is pinned to a role here
const asRole = vi.hoisted(() => ({ id: 'role_owner' }))
vi.mock('#/hooks/useData', async (orig) => {
  const real = await orig<typeof import('#/hooks/useData')>()
  const { defaultRoles } = await import('#/services/storage/settingsStorage')
  const keys = { view: 'viewModules', create: 'createRecords', edit: 'editRecords', delete: 'deleteRecords' } as const
  return {
    ...real,
    usePerms: () => {
      const role = defaultRoles().find((r) => r.id === asRole.id)!
      const can = (k: string) => !!(role.permissions as Record<string, boolean>)[k]
      return { role, can, canModule: (_m: unknown, a: keyof typeof keys) => can(keys[a]), fieldAccess: (f: Field) => f.permissions?.[role.id] ?? 'edit' }
    },
  }
})

const opts = (n: number): Field['options'] => Array.from({ length: n }, (_, i) => ({ id: `o${i + 1}`, label: `Option ${i + 1}` }))
const choice = (n: number, extra: Partial<Field> = {}) => field('pick', 'dropdown', { options: opts(n), ...extra })
const rs = () => useRecordStore.getState()

beforeAll(() => startEngine())
afterAll(() => stopEngine())
beforeEach(() => resetWorld())

describe('controlFor: which control a field gets', () => {
  it('yes/no and two-option choices are toggles', () => {
    expect(controlFor(field('active', 'yesNo'))).toBe('toggle')
    expect(controlFor(choice(2))).toBe('toggle')
    expect(controlFor(field('r', 'radio', { options: opts(2) }))).toBe('toggle')
    expect(controlForFromComponent(choice(2))).toBe('toggle') // re-exported from the component module
    expect(toggleValues(choice(2))).toMatchObject({ off: 'o1', on: 'o2', offLabel: 'Option 1', onLabel: 'Option 2' })
    expect(toggleValues(field('a', 'yesNo'))).toMatchObject({ off: false, on: true })
  })

  it('NEVER a toggle for more than two states', () => {
    for (let n = 3; n <= 12; n++) for (const surface of ['table', 'card', 'drawer'] as const) expect(controlFor(choice(n), surface)).not.toBe('toggle')
  })

  it('3+ options: dropdown; segmented in the drawer up to 4 options', () => {
    expect(controlFor(choice(3), 'table')).toBe('select')
    expect(controlFor(choice(4), 'card')).toBe('select')
    expect(controlFor(choice(3), 'drawer')).toBe('segmented')
    expect(controlFor(choice(4), 'drawer')).toBe('segmented')
    expect(controlFor(choice(5), 'drawer')).toBe('select')
    expect(controlFor(choice(1), 'drawer')).toBe('select')
  })

  it('dates, numbers, plain text, and read-only kinds', () => {
    expect(controlFor(field('d', 'date'))).toBe('date')
    expect(controlFor(field('d', 'datetime'))).toBe('date')
    for (const t of ['number', 'currency', 'percentage'] as const) expect(controlFor(field('n', t))).toBe('number')
    for (const t of ['shortText', 'email', 'phone', 'longText', 'relationship', 'multiSelect'] as const) expect(controlFor(field('x', t))).toBe('text')
    expect(controlFor(field('c', 'currency', { calculated: true }))).toBe('readonly')
    expect(controlFor(field('f', 'formula'))).toBe('readonly')
    expect(controlFor(field('i', 'autoId'))).toBe('readonly')
    expect(controlFor(field('ro', 'number', { readOnly: true }))).toBe('readonly')
    expect(controlFor(field('calc-bool', 'yesNo', { calculated: true }))).toBe('readonly')
    expect(controlFor(choice(2, { calculated: true }))).toBe('readonly')
  })
})

describe('who may edit, what needs confirming, how typing is read', () => {
  const edit = { canEditModule: true, access: 'edit' as const }

  it('permission denial makes the control read-only (with a reason)', () => {
    expect(editableState(field('n', 'number'), edit)).toEqual({ editable: true })
    expect(editableState(field('n', 'number'), { ...edit, canEditModule: false })).toMatchObject({ editable: false })
    expect(editableState(field('n', 'number'), { ...edit, access: 'view' })).toMatchObject({ editable: false })
    expect(editableState(field('n', 'number'), { ...edit, trashed: true })).toMatchObject({ editable: false, reason: 'This record is in the trash' })
    expect(editableState(field('c', 'currency', { calculated: true }), edit)).toMatchObject({ editable: false, reason: 'Calculated automatically' })
    expect(editableState(field('f', 'formula'), edit)).toMatchObject({ editable: false })
    expect(editableState(field('i', 'autoId'), edit)).toMatchObject({ editable: false })
    const viewer = roleById('role_viewer')
    expect(editableState(field('n', 'number'), { canEditModule: !!viewer.permissions.editRecords, access: 'edit' })).toMatchObject({ editable: false })
  })

  it('sensitive fields and sensitive options ask first', () => {
    expect(confirmMessage(field('s', 'number', { sensitive: true }), 5)).toMatch(/sensitive/)
    const status = choice(3, { label: 'Status', sensitiveOptions: ['o3'] })
    expect(confirmMessage(status, 'o3')).toMatch(/Option 3/)
    expect(confirmMessage(status, 'o1')).toBeNull()
    expect(confirmMessage(field('n', 'number'), 5)).toBeNull()
  })

  it('reads typed numbers: commas, blanks, ranges, garbage', () => {
    const f = field('n', 'number', { min: 0, max: 10, label: 'Qty' })
    expect(parseInlineValue(f, '7.5')).toEqual({ ok: true, value: 7.5 })
    expect(parseInlineValue(field('m', 'currency'), '1,200.50')).toEqual({ ok: true, value: 1200.5 })
    expect(parseInlineValue(f, '  ')).toEqual({ ok: true, value: '' })
    expect(parseInlineValue(f, 'abc')).toMatchObject({ ok: false })
    expect(parseInlineValue(f, '-1')).toMatchObject({ ok: false, error: 'Qty must be at least 0' })
    expect(parseInlineValue(f, '11')).toMatchObject({ ok: false, error: 'Qty must be at most 10' })
  })
})

describe('commitInline: optimistic save with rollback', () => {
  const f = field('paid_amount', 'currency', { label: 'Paid' })
  const mk = (over: Partial<CommitDeps> = {}) => {
    const deps: CommitDeps = { write: vi.fn(() => ({ record: {} })), confirm: vi.fn(async () => true), onError: vi.fn(), ...over }
    return deps
  }

  it('saves through the record store write and reports unchanged values without writing', async () => {
    const deps = mk()
    expect(await commitInline({ recordId: 'r1', field: f, prev: 10, next: 25, deps })).toEqual({ status: 'saved' })
    expect(deps.write).toHaveBeenCalledWith('r1', { paid_amount: 25 })
    expect(await commitInline({ recordId: 'r1', field: f, prev: 25, next: 25, deps })).toEqual({ status: 'unchanged' })
    expect(await commitInline({ recordId: 'r1', field: f, prev: '', next: null, deps })).toEqual({ status: 'unchanged' })
    expect(deps.write).toHaveBeenCalledTimes(1)
    expect(deps.onError).not.toHaveBeenCalled()
  })

  it('a refused write (validation) is an error toast and a rollback signal', async () => {
    const deps = mk({ write: vi.fn(() => ({ errors: { paid_amount: 'Paid must be at least 0' } })) })
    const res = await commitInline({ recordId: 'r1', field: f, prev: 10, next: -5, deps })
    expect(res).toEqual({ status: 'error', message: 'Paid must be at least 0' })
    expect(deps.onError).toHaveBeenCalledWith('Could not save Paid', 'Paid must be at least 0')
  })

  it('a write that THROWS is rolled back (previous value written again) and reported', async () => {
    const write = vi.fn().mockImplementationOnce(() => { throw new Error('disk full') }).mockImplementation(() => ({ record: {} }))
    const deps = mk({ write })
    const res = await commitInline({ recordId: 'r1', field: f, prev: 10, next: 99, deps })
    expect(res).toEqual({ status: 'error', message: 'disk full' })
    expect(write).toHaveBeenNthCalledWith(1, 'r1', { paid_amount: 99 })
    expect(write).toHaveBeenNthCalledWith(2, 'r1', { paid_amount: 10 }) // rollback
    expect(deps.onError).toHaveBeenCalledWith('Could not save Paid', 'disk full')
  })

  it('a record that no longer exists is an error, not a crash', async () => {
    const deps = mk({ write: vi.fn(() => null) })
    expect(await commitInline({ recordId: 'gone', field: f, prev: 1, next: 2, deps })).toMatchObject({ status: 'error' })
  })

  it('sensitive changes wait for the confirmation: declined = nothing is written', async () => {
    const sensitive = field('status', 'dropdown', { label: 'Status', options: opts(3), sensitiveOptions: ['o3'] })
    const no = mk({ confirm: vi.fn(async () => false) })
    expect(await commitInline({ recordId: 'r1', field: sensitive, prev: 'o1', next: 'o3', deps: no })).toEqual({ status: 'cancelled' })
    expect(no.write).not.toHaveBeenCalled()
    const yes = mk()
    expect(await commitInline({ recordId: 'r1', field: sensitive, prev: 'o1', next: 'o3', deps: yes })).toEqual({ status: 'saved' })
    expect(yes.confirm).toHaveBeenCalledTimes(1)
    // a harmless option does not ask
    const quiet = mk()
    await commitInline({ recordId: 'r1', field: sensitive, prev: 'o3', next: 'o1', deps: quiet })
    expect(quiet.confirm).not.toHaveBeenCalled()
  })

  it('against the REAL record store: the edit recalculates, and a validation failure leaves the record untouched', async () => {
    putModules(mod('mod_fees', 'Fees', [field('total_amount', 'currency'), field('paid_amount', 'currency', { min: 0, label: 'Paid' }), field('remaining_amount', 'currency', { calculated: true, readOnly: true })]))
    expect(saveConfig(WS, { type: 'calculation', name: 'Remaining', entity: 'mod_fees', output_field: 'remaining_amount', operation: 'subtract', inputs: [{ field: 'total_amount', default: 0 }, { field: 'paid_amount', default: 0 }] }, { role: null }).ok).toBe(true)
    const id = rs().create('mod_fees', { total_amount: 1000 }).record!.id
    const live: CommitDeps = { write: (rid, patch) => rs().update(rid, patch, { validate: true }), confirm: async () => true, onError: vi.fn() }
    const paid = useModuleStore.getState().modules[0].fields.find((x) => x.id === 'paid_amount')!
    expect(await commitInline({ recordId: id, field: paid, prev: dataOf(id).paid_amount, next: 400, deps: live })).toEqual({ status: 'saved' })
    expect(dataOf(id).paid_amount).toBe(400)
    expect(dataOf(id).remaining_amount).toBe(600) // the engine ran
    const bad = await commitInline({ recordId: id, field: paid, prev: 400, next: -5, deps: live })
    expect(bad.status).toBe('error')
    expect(dataOf(id).paid_amount).toBe(400) // rolled back: never written
    expect(dataOf(id).remaining_amount).toBe(600)
    expect(live.onError).toHaveBeenCalledTimes(1)
  })
})

describe('InlineField renders the right control (server-side)', () => {
  const render = (f: Field, value: unknown, surface: 'table' | 'drawer' = 'table', roleId = 'role_owner') => {
    asRole.id = roleId
    resetWorld({ roleId })
    const m = mod('mod_x', 'Things', [f])
    putModules(m)
    const record = { id: 'rec1', workspaceId: WS, moduleId: 'mod_x', data: { [f.id]: value }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
    return renderToStaticMarkup(<InlineField module={m} record={record} field={f} ctx={makeCtx([m], [record], [])} surface={surface} />)
  }

  it('toggle for yes/no and two options; segmented for 3-4 in the drawer; dropdown for more', () => {
    expect(render(field('active', 'yesNo'), true)).toContain('role="switch"')
    expect(render(choice(2), 'o2')).toContain('role="switch"')
    expect(render(choice(2), 'o2')).toContain('aria-checked="true"')
    const three = render(choice(3), 'o1', 'drawer')
    expect(three).not.toContain('role="switch"')
    expect(three).toContain('Option 3')
    expect(three).not.toContain('<select')
    const six = render(choice(6), 'o1', 'drawer')
    expect(six).toContain('<select')
    expect(six).not.toContain('role="switch"')
    expect(render(choice(3), 'o1', 'table')).toContain('<select')
  })

  it('number and date controls', () => {
    expect(render(field('amount', 'currency', { label: 'Amount' }), 12)).toContain('inputMode="decimal"')
    expect(render(field('due', 'date'), '2026-03-01')).toContain('type="date"')
  })

  it('read-only for a viewer, and for calculated fields (nobody can type into them)', () => {
    const viewer = render(field('active', 'yesNo'), true, 'table', 'role_viewer')
    expect(viewer).toContain('data-readonly="true"')
    expect(viewer).not.toContain('role="switch"')
    expect(render(field('amount', 'currency'), 12, 'table', 'role_viewer')).not.toContain('<input')
    const calc = render(field('total', 'currency', { calculated: true, readOnly: true }), 12)
    expect(calc).toContain('data-readonly="true"')
    expect(calc).not.toContain('<input')
    expect(render(field('amount', 'currency'), 12)).toContain('<input')
  })
})

describe('JSON editor validation (the same check the editor runs on every keystroke)', () => {
  beforeEach(() => {
    putModules(feesModule(), mod('mod_other', 'Other', [field('x', 'number')]))
  })
  const calc = (over: Record<string, unknown> = {}) => ({ type: 'calculation', name: 'Remaining', entity: 'mod_fees', output_field: 'remaining_amount', operation: 'subtract', inputs: [{ field: 'total_amount', default: 0 }, { field: 'paid_amount', default: 0 }], ...over })
  const check = (v: unknown, extra: Partial<Parameters<typeof checkJson>[2]> = {}) => checkJson(typeof v === 'string' ? v : JSON.stringify(v), WS, { expected: 'calculations', role: null, ...extra })

  it('accepts a valid configuration', () => {
    const res = check(calc())
    expect(res.errors).toEqual([])
    expect(res.ok).toBe(true)
  })

  it('rejects bad JSON, empty text and the wrong type, each with a path', () => {
    expect(check('{ nope')).toMatchObject({ ok: false, errors: [{ path: '(root)', message: expect.stringContaining('Not valid JSON') }] })
    expect(check('   ')).toMatchObject({ ok: false })
    expect(check({ ...calc(), type: 'conditional_rule' }).ok).toBe(false)
    const bad = check(calc({ operation: 'multiplyy' }))
    expect(bad.ok).toBe(false)
    expect(bad.errors[0].path).toContain('operation')
  })

  it('rejects an unknown field, naming it and the path', () => {
    const res = check(calc({ inputs: [{ field: 'nope_field' }, { field: 'paid_amount' }] }))
    expect(res.ok).toBe(false)
    expect(res.errors[0].path).toBe('inputs.0.field')
    expect(res.errors[0].message).toContain('"nope_field" does not exist')
  })

  it('rejects a numeric operation on a text field, and a result that is also an input', () => {
    const text = check(calc({ inputs: [{ field: 'notes' }, { field: 'paid_amount' }] }))
    expect(text.ok).toBe(false)
    expect(text.errors[0].message).toMatch(/needs a number/)
    const self = check(calc({ output_field: 'paid_amount' }))
    expect(self.ok).toBe(false)
    expect(self.errors.map((e) => e.message).join(' ')).toContain('also an input')
  })

  it('rejects a rule with a bad operator or an unknown module', () => {
    const rule = (c: unknown) => ({ type: 'conditional_rule', name: 'R', entity: 'mod_fees', rules: [{ conditions: [c], actions: [{ type: 'set_status', value: 'Paid' }] }] })
    const op = checkJson(JSON.stringify(rule({ field: 'total_amount', operator: 'bigger_than', value: 1 })), WS, { expected: 'conditional_rules', role: null })
    expect(op.ok).toBe(false)
    const bad = checkJson(JSON.stringify({ ...rule({ field: 'total_amount', operator: 'greater_than', value: 1 }), entity: 'mod_nowhere' }), WS, { expected: 'conditional_rules', role: null })
    expect(bad.errors[0].message).toContain('does not exist')
    const ok = checkJson(JSON.stringify(rule({ field: 'total_amount', operator: 'greater_than', value: 1 })), WS, { expected: 'conditional_rules', role: null })
    expect(ok.errors).toEqual([])
  })

  it('a circular dependency is reported with the names that form the cycle (Save stays disabled)', () => {
    const a = saveConfig(WS, calc({ name: 'B calc', output_field: 'b_out', inputs: [{ field: 'total_amount', default: 0 }], operation: 'add' }), { role: null })
    const b = saveConfig(WS, calc({ name: 'A calc', output_field: 'a_out', inputs: [{ field: 'b_out', default: 0 }], operation: 'add' }), { role: null })
    expect(a.ok && b.ok).toBe(true)
    // now make B read A's result
    const res = check(calc({ name: 'B calc', output_field: 'b_out', inputs: [{ field: 'a_out', default: 0 }], operation: 'add' }), { id: a.item!.id })
    expect(res.ok).toBe(false)
    expect(res.cycle).toBeDefined()
    expect(res.errors[0].path).toBe('(dependencies)')
    expect(res.errors[0].message).toContain('Circular dependency')
    expect(res.errors[0].message).toContain('"A calc"')
    expect(res.errors[0].message).toContain('"B calc"')
  })

  it('a role without permission cannot save (the editor shows why)', () => {
    const res = check(calc(), { role: roleById('role_viewer') })
    expect(res.ok).toBe(false)
    expect(res.errors[0].path).toBe('(permission)')
  })
})

describe('preview, dependency info and summaries', () => {
  beforeEach(() => {
    putModules(feesModule())
    for (let i = 0; i < 7; i++) rs().create('mod_fees', { total_amount: 100 * (i + 1), paid_amount: 50 }, { silent: true })
  })
  const remaining = { type: 'calculation' as const, name: 'Remaining', entity: 'mod_fees', output_field: 'remaining_amount', operation: 'subtract' as const, inputs: [{ field: 'total_amount', default: 0 }, { field: 'paid_amount', default: 0 }] }

  it('previews a calculation on at most 5 real records and writes nothing', () => {
    const before = JSON.stringify(rs().records)
    const p = previewConfig(WS, remaining)
    expect(p.ok).toBe(true)
    expect(p.rows).toHaveLength(5)
    expect(p.rows.map((r) => r.after)).toEqual(['50', '150', '250', '350', '450'])
    expect(JSON.stringify(rs().records)).toBe(before)
  })

  it('previews an aggregate as one row, a rule per record, and reports a broken module', () => {
    const agg = previewConfig(WS, { ...remaining, name: 'Total', operation: 'sum', scope: 'aggregate', output_field: undefined, inputs: [{ field: 'total_amount' }] })
    expect(agg.rows).toEqual([{ title: 'All Fees', before: '—', after: '2800' }])
    const rule = previewConfig(WS, paymentStatusRule('mod_fees'))
    expect(rule.ok).toBe(true)
    expect(rule.rows).toHaveLength(5)
    expect(rule.rows[0].after).toMatch(/payment status = /i)
    expect(previewConfig(WS, { ...remaining, entity: 'mod_missing' })).toMatchObject({ ok: false, error: expect.stringContaining('does not exist') })
  })

  it('dependency info: what a config reads, writes, runs after and feeds', () => {
    const calc = saveConfig(WS, remaining, { role: null }).item!
    const rule = saveConfig(WS, paymentStatusRule('mod_fees', { paid: 'remaining_amount' }), { role: null }).item! // reads the calculated field
    const c = dependencyInfo(WS, calc.id)!
    expect(c.reads).toEqual(expect.arrayContaining(['Fees.total amount', 'Fees.paid amount']))
    expect(c.writes).toEqual(['Fees.remaining amount'])
    expect(c.usedBy).toContain('Automatic Payment Status')
    const r = dependencyInfo(WS, rule.id)!
    expect(r.dependsOn).toContain('Remaining')
    expect(r.inCycle).toBe(false)
    expect(dependencyInfo(WS, 'nope')).toBeUndefined()
    expect(summarize(remaining, useModuleStore.getState().modules[0])).toBe('subtract(total amount, paid amount) → remaining amount')
  })

  it('the blank templates of the guided forms are valid starting points', () => {
    const m = useModuleStore.getState().modules[0]
    const c = blankCalculation(m)
    expect(c.entity).toBe('mod_fees')
    expect(checkJson(toJson(c), WS, { expected: 'calculations', role: null }).errors).toEqual([])
    expect(blankRule(m).rules).toHaveLength(1)
    expect(blankRule(m).entity).toBe('mod_fees')
  })
})
