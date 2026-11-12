import { describe, expect, it } from 'vitest'
import { runSearch, type SearchEnv } from '#/genius/search/query'
import { defaultRoles } from '#/services/storage/settingsStorage'

const WS = 'ws1'
const f = (id: string, label: string, type: string, extra: any = {}) => ({ id, name: id, label, type, order: 0, width: 'full', ...extra })
const mod = (id: string, name: string, fields: any[], extra: any = {}) => ({ id, workspaceId: WS, name, singularName: name.replace(/s$/, ''), icon: 'Box', color: '#000', fields, order: 0, visible: true, archived: false, ...extra })
const rec = (id: string, moduleId: string, data: any, createdAt = '2026-01-01T00:00:00.000Z', ws = WS) => ({ id, workspaceId: ws, moduleId, data, createdAt, updatedAt: createdAt })

const tenants = mod('tenants', 'Tenants', [f('name', 'Name', 'shortText'), f('email', 'Email', 'email'), f('city', 'City', 'shortText'), f('notes', 'Notes', 'longText'), f('status', 'Status', 'dropdown', { options: [{ id: 'active', label: 'Active' }, { id: 'past', label: 'Past' }] })], { titleFieldId: 'name' })
const landlords = mod('landlords', 'Landlords', [f('name', 'Name', 'shortText'), f('city', 'City', 'shortText')], { titleFieldId: 'name' })
const payments = mod('payments', 'Payments', [f('ref', 'Reference', 'shortText'), f('amount', 'Amount', 'currency'), f('state', 'State', 'dropdown', { options: [{ id: 'paid', label: 'Paid' }, { id: 'overdue', label: 'Overdue' }] }), f('tenant', 'Tenant', 'relationship', { relation: { moduleId: 'tenants', cardinality: 'many-to-one' } }), f('due', 'Due date', 'date')], { titleFieldId: 'ref' })
const secret = mod('secret', 'Secrets', [f('name', 'Name', 'shortText')], { permissions: { role_owner: { view: true }, role_viewer: { view: false } } })

const records = [
  rec('t1', 'tenants', { name: 'Amelia Stone', email: 'amelia@example.com', city: 'London', notes: 'Looking for a quiet shared home near the park', status: 'active' }, '2026-03-01T00:00:00.000Z'),
  rec('t2', 'tenants', { name: 'Brian Cole', email: 'brian@example.com', city: 'Leeds', notes: 'Works nights', status: 'past' }, '2026-03-02T00:00:00.000Z'),
  rec('t3', 'tenants', { name: 'Carla Stone', email: 'carla@example.com', city: 'London', status: 'active' }, '2026-03-03T00:00:00.000Z'),
  rec('l1', 'landlords', { name: 'Stone Properties', city: 'London' }),
  rec('p1', 'payments', { ref: 'P-100', amount: 750, state: 'overdue', tenant: 't1', due: '2026-02-01' }),
  rec('p2', 'payments', { ref: 'P-101', amount: 300, state: 'paid', tenant: 't1', due: '2026-03-01' }),
  rec('p3', 'payments', { ref: 'P-102', amount: 200, state: 'overdue', tenant: 't2', due: '2026-02-15' }),
  rec('x1', 'secret', { name: 'Stone vault' }),
  rec('foreign', 'tenants', { name: 'Stone Elsewhere', city: 'London' }, '2026-03-04T00:00:00.000Z', 'ws_other'),
  rec('gone', 'tenants', { name: 'Stone Deleted', city: 'London' }),
]
;(records[records.length - 1] as any).deletedAt = '2026-03-05T00:00:00.000Z'

const roles = defaultRoles()
const owner = { userId: 'u1', role: roles.find((r) => r.id === 'role_owner') }
const env = (actor = owner): SearchEnv => ({ workspaceId: WS, modules: [tenants, landlords, payments, secret] as any, records: records as any, users: [], actor })
const ids = (r: ReturnType<typeof runSearch>) => r.hits.map((h) => h.recordId)

describe('typed search (no SQL, no model arithmetic)', () => {
  it('finds an exact identifier first, and a name across modules', () => {
    expect(ids(runSearch({ text: 'brian@example.com' }, env()))[0]).toBe('t2')
    const r = runSearch({ text: 'stone' }, env())
    // tenants and the landlord match by name; Amelia Stone's payments match through the link to her (relation context is searchable)
    expect(ids(r).sort()).toEqual(['l1', 'p1', 'p2', 't1', 't3', 'x1'])
    expect(r.moduleCounts).toEqual({ tenants: 2, landlords: 1, payments: 2, secret: 1 })
  })

  it('applies structured filters as hard constraints, with real types', () => {
    const r = runSearch({ scope: ['tenants'], filters: [{ field: 'city', op: 'eq', value: 'london' }, { field: 'status', op: 'eq', value: 'Active' }] }, env())
    expect(ids(r).sort()).toEqual(['t1', 't3'])
    const money = runSearch({ scope: ['payments'], filters: [{ field: 'amount', op: 'gt', value: 250 }, { field: 'state', op: 'eq', value: 'overdue' }] }, env())
    expect(ids(money)).toEqual(['p1'])
    const dates = runSearch({ scope: ['Payments'], filters: [{ field: 'Due date', op: 'lt', value: '2026-02-20' }] }, env())
    expect(ids(dates).sort()).toEqual(['p1', 'p3'])
  })

  it('follows a real relationship: tenants that have overdue payments over 500', () => {
    const r = runSearch({ scope: ['tenants'], related: [{ module: 'payments', where: [{ field: 'state', op: 'eq', value: 'overdue' }, { field: 'amount', op: 'gt', value: 500 }] }] }, env())
    expect(ids(r)).toEqual(['t1'])
    const none = runSearch({ scope: ['tenants'], related: [{ module: 'payments', exists: false, where: [{ field: 'state', op: 'eq', value: 'overdue' }] }] }, env())
    expect(ids(none)).toEqual(['t3'])
    const up = runSearch({ scope: ['payments'], related: [{ module: 'tenants', where: [{ field: 'city', op: 'eq', value: 'London' }] }] }, env())
    expect(ids(up).sort()).toEqual(['p1', 'p2'])
  })

  it('computes aggregates itself, exactly', () => {
    const r = runSearch({ scope: ['payments'], filters: [{ field: 'state', op: 'eq', value: 'overdue' }], aggregate: { op: 'sum', field: 'amount' } }, env())
    expect(r.aggregate?.values).toEqual([{ module: 'Payments', value: 950 }])
    expect(runSearch({ scope: ['tenants'], aggregate: { op: 'count' } }, env()).aggregate?.values[0].value).toBe(3)
  })

  it('finds meaning in free text, ranks, sorts and pages', () => {
    expect(ids(runSearch({ scope: ['tenants'], text: 'quiet shared home' }, env()))).toEqual(['t1'])
    expect(ids(runSearch({ scope: ['payments'], sort: [{ field: 'amount', dir: 'desc' }] }, env()))).toEqual(['p1', 'p2', 'p3'])
    expect(ids(runSearch({ scope: ['payments'], sort: [{ field: 'amount', dir: 'desc' }], limit: 1, offset: 1 }, env()))).toEqual(['p2'])
    expect(runSearch({ text: 'quiet' }, env()).hits[0].matched?.field).toBe('Notes')
  })

  it('never invents a field or module, and never leaks across workspaces, deleted records or permissions', () => {
    const bad = runSearch({ scope: ['tenants'], filters: [{ field: 'salary', op: 'gt', value: 1 }] }, env())
    expect(bad.ok).toBe(false)
    expect(bad.errors[0]).toMatch(/Unknown field "salary"/)
    expect(runSearch({ scope: ['nope'] }, env()).errors[0]).toMatch(/Unknown or hidden module/)
    const all = runSearch({ text: 'stone' }, env())
    expect(ids(all)).not.toContain('foreign')
    expect(ids(all)).not.toContain('gone')
    const viewer = { userId: 'u2', role: roles.find((r) => r.id === 'role_viewer') ?? roles[roles.length - 1] }
    expect(ids(runSearch({ text: 'vault' }, env(viewer)))).toEqual([])
    expect(runSearch({ text: 'vault' }, env(owner)).hits.length).toBe(1)
  })
})
