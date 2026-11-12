import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { EngineDashboardGrid } from '#/components/dashboard/EngineDashboardGrid'
import { EngineWidgetView } from '#/components/dashboard/EngineWidget'
import { addWidget, duplicateWidget, MAX_COLS, MAX_ROWS, moveWidget, newWidget, removeWidget, resizeWidget, setWidgetEnabled, sortedWidgets, updateWidget } from '#/engine/dashboardOps'
import { createUserDashboard, hasOwnCopy, restoreDefaultDashboard, saveDashboardLayout, validateWidget } from '#/engine/dashboardService'
import { ensureDefaultDashboard } from '#/engine/defaultDashboard'
import { visibleDashboards } from '#/engine/dashboards'
import type { Calculation, DashboardWidgetShape, WidgetKind } from '#/engine/schema'
import { WIDGET_KINDS } from '#/engine/schema'
import { saveConfig } from '#/engine/service'
import { buildRange, finalizeWidget, inlineCalculation, rangeParts } from '#/engine/widgetForm'
import { computeEngineWidget, type WidgetData } from '#/engine/widgets'
import { parseDocs, serializeDocs } from '#/services/storage/engineStorage'
import { createWorkspace } from '#/services/workspaceService'
import { useEngineStore } from '#/stores/engineStore'
import { useModuleStore } from '#/stores/moduleStore'
import { useRecordStore } from '#/stores/recordStore'
import { BUILTIN_TEMPLATES } from '#/templates'
import { envOf, field, mod, putModules, rec } from './engine-fixtures'
import { resetWorld, roleById, WS } from './helpers'

const SALES = () =>
  mod('mod_sales', 'Sales', [
    field('amount', 'currency', { currency: 'USD' }),
    field('cost', 'currency', { currency: 'USD' }),
    field('stage', 'dropdown', { options: [{ id: 'open', label: 'Open' }, { id: 'won', label: 'Won' }, { id: 'lost', label: 'Lost' }] }),
    field('closed', 'date'),
  ])

// amounts are chosen so floating point would be wrong (100.10 + 200.20 !== 300.3 in doubles)
const RECORDS = () => [
  rec('mod_sales', 's1', { amount: 100.1, cost: 40, stage: 'won', closed: '2026-03-02' }, { createdAt: '2026-03-02T10:00:00.000Z' }),
  rec('mod_sales', 's2', { amount: 200.2, cost: 50, stage: 'open', closed: '2026-03-10' }, { createdAt: '2026-03-10T10:00:00.000Z' }),
  rec('mod_sales', 's3', { amount: 50, cost: 70, stage: 'lost', closed: '2026-02-10' }, { createdAt: '2026-02-10T10:00:00.000Z' }),
  rec('mod_sales', 's4', { amount: '', cost: '', stage: 'won', closed: '2026-01-05' }, { createdAt: '2026-01-05T10:00:00.000Z' }),
]

let seq = 0
const widget = (type: WidgetKind, source: DashboardWidgetShape['source'], extra: Partial<DashboardWidgetShape> = {}): DashboardWidgetShape => ({ id: `w${++seq}`, type, title: type, enabled: true, layout: { w: 1, h: 1, order: seq }, source, ...extra })
const env = () => envOf([SALES()], RECORDS())
const run = (w: DashboardWidgetShape, opts = {}) => computeEngineWidget(w, env(), opts)
const as = <K extends WidgetData['kind']>(d: WidgetData, kind: K) => {
  expect(d.kind).toBe(kind)
  return d as Extract<WidgetData, { kind: K }>
}
const won = [{ field: 'stage', operator: 'equal' as const, value: 'won' }]

describe('widget config -> aggregate result', () => {
  it('record count: all, filtered, and in a date window', () => {
    expect(as(run(widget('record_count', { entity: 'mod_sales' })), 'value').value).toBe(4)
    expect(as(run(widget('record_count', { entity: 'mod_sales', filters: won })), 'value').value).toBe(2)
    expect(as(run(widget('record_count', { entity: 'mod_sales', dateRange: { preset: 'this_month', field: 'closed' } })), 'value').value).toBe(2)
    expect(as(run(widget('record_count', { entity: 'mod_sales', dateRange: 'last_month' as never })), 'value').value).toBe(1) // by created date
  })

  it('kpi / revenue / average / min / max are exact (no floating point drift)', () => {
    const sum = as(run(widget('kpi', { entity: 'mod_sales', field: 'amount', aggregation: 'sum' }, { format: { kind: 'currency', precision: 2, currency: 'USD' } })), 'value')
    expect(sum.value).toBe(350.3)
    expect(sum.count).toBe(4)
    expect(as(run(widget('revenue', { entity: 'mod_sales', field: 'amount' })), 'value').value).toBe(350.3)
    expect(as(run(widget('average', { entity: 'mod_sales', field: 'amount' })), 'value').value).toBeCloseTo(116.7667, 3)
    expect(as(run(widget('kpi', { entity: 'mod_sales', field: 'amount', aggregation: 'max' })), 'value').value).toBe(200.2)
    expect(as(run(widget('kpi', { entity: 'mod_sales', field: 'amount', aggregation: 'min' })), 'value').value).toBe(50)
  })

  it('profit / loss = income minus expenses, and the loss case is negative', () => {
    const p = as(run(widget('profit_loss', { entity: 'mod_sales', field: 'amount', expenseField: 'cost' })), 'profit')
    expect(p).toMatchObject({ income: 350.3, expense: 160, profit: 190.3 })
    const lossy = as(run(widget('profit_loss', { entity: 'mod_sales', field: 'amount', expenseField: 'cost', filters: [{ field: 'stage', operator: 'equal', value: 'lost' }] })), 'profit')
    expect(lossy.profit).toBe(-20)
  })

  it('percentage is matched / all, progress is value / target (capped at 100)', () => {
    expect(as(run(widget('percentage', { entity: 'mod_sales', filters: won })), 'percentage')).toMatchObject({ value: 50, matched: 2, total: 4 })
    expect(as(run(widget('progress', { entity: 'mod_sales', field: 'amount', aggregation: 'sum' }, { target: 700 })), 'progress')).toMatchObject({ value: 350.3, target: 700, pct: 50 })
    expect(as(run(widget('progress', { entity: 'mod_sales', field: 'amount', aggregation: 'sum' }, { target: 100 })), 'progress').pct).toBe(100)
    expect(run(widget('progress', { entity: 'mod_sales', field: 'amount' })).kind).toBe('empty') // no target: tells you what to do
  })

  it('conditional stat only counts the records that match', () => {
    expect(as(run(widget('conditional_stat', { entity: 'mod_sales', field: 'amount', aggregation: 'sum', filters: won })), 'value').value).toBe(100.1)
    expect(as(run(widget('conditional_stat', { entity: 'mod_sales', aggregation: 'count', filters: [{ field: 'amount', operator: 'greater_than', value: 75 }] })), 'value').value).toBe(2)
  })

  it('bar / pie / doughnut / status breakdown group by a field, in option order', () => {
    const bar = as(run(widget('bar_chart', { entity: 'mod_sales', groupBy: 'stage', aggregation: 'count' })), 'series')
    expect(bar.points.map((p) => [p.name, p.value])).toEqual([['Open', 1], ['Won', 2], ['Lost', 1]])
    expect(bar.donut).toBe(false)
    const pie = as(run(widget('pie_chart', { entity: 'mod_sales', groupBy: 'stage', field: 'amount', aggregation: 'sum' })), 'series')
    expect(pie.points.map((p) => [p.name, p.value])).toEqual([['Open', 200.2], ['Won', 100.1], ['Lost', 50]])
    expect(pie.total).toBeCloseTo(350.3, 6)
    expect(as(run(widget('doughnut_chart', { entity: 'mod_sales', groupBy: 'stage', aggregation: 'count' })), 'series').donut).toBe(true)
    const status = as(run(widget('status_breakdown', { entity: 'mod_sales', groupBy: 'stage', aggregation: 'count' })), 'series')
    expect(status.total).toBe(4)
    // no groupBy: falls back to the first choice field
    expect(as(run(widget('status_breakdown', { entity: 'mod_sales' })), 'series').points.map((p) => p.name)).toEqual(['Open', 'Won', 'Lost'])
  })

  it('line chart buckets by month in time order', () => {
    const line = as(run(widget('line_chart', { entity: 'mod_sales', field: 'amount', aggregation: 'sum', groupBy: 'closed', dateRange: { preset: 'all', bucket: 'month' } })), 'series')
    expect(line.points.map((p) => p.value)).toEqual([0, 50, 300.3])
    expect(line.points).toHaveLength(3)
    // no date configured: grouped by created date, monthly
    const created = as(run(widget('line_chart', { entity: 'mod_sales', aggregation: 'count' })), 'series')
    expect(created.points.map((p) => p.value)).toEqual([1, 1, 2])
  })

  it('table / recent records: newest first, limited, filtered', () => {
    const t = as(run(widget('table', { entity: 'mod_sales' }, { limit: 2 })), 'rows')
    expect(t.records.map((r) => r.id)).toEqual(['s2', 's1'])
    expect(as(run(widget('recent_records', { entity: 'mod_sales', filters: won })), 'rows').records.map((r) => r.id)).toEqual(['s1', 's4'])
    expect(as(run(widget('recent_activity', undefined, { limit: 5 })), 'activity').limit).toBe(5)
  })

  it('custom calculation: saved (by id or name) and inline', () => {
    resetWorld()
    putModules(SALES())
    useRecordStore.getState().setAll(RECORDS())
    const saved = saveConfig(WS, { type: 'calculation', name: 'Won revenue', entity: 'mod_sales', scope: 'aggregate', operation: 'sum', inputs: [{ field: 'amount' }], filters: won }, { role: null })
    expect(saved.ok).toBe(true)
    const calculations = useEngineStore.getState().list(WS, 'calculations') as Calculation[]
    const e = envOf([SALES()], RECORDS())
    expect(as(computeEngineWidget(widget('calculation', undefined, { calculation: saved.item!.id }), e, { calculations }), 'value').value).toBe(100.1)
    expect(as(computeEngineWidget(widget('calculation', undefined, { calculation: 'Won revenue' }), e, { calculations }), 'value').value).toBe(100.1)
    const inline = inlineCalculation('All cost', { entity: 'mod_sales', field: 'cost', aggregation: 'sum' })
    expect(as(computeEngineWidget(widget('calculation', undefined, { calculation: inline }), e), 'value').value).toBe(160)
    expect(computeEngineWidget(widget('calculation', undefined, { calculation: 'Deleted one' }), e, { calculations }).kind).toBe('error')
  })

  it('error, empty and no-access states instead of crashes', () => {
    const missing = run(widget('kpi', { entity: 'mod_gone', field: 'amount' }))
    expect(as(missing, 'error').message).toContain('no longer exists')
    expect(as(run(widget('kpi', undefined)), 'empty').hint).toMatch(/module/i)
    expect(as(run(widget('record_count', { entity: 'mod_sales' }), { canView: () => false }), 'empty').hint).toContain('do not have access')
    const noRecords = computeEngineWidget(widget('kpi', { entity: 'mod_sales', field: 'amount', aggregation: 'sum' }), envOf([SALES()], []))
    expect(as(noRecords, 'value').count).toBe(0)
  })

  it('is reactive: new records give new numbers, and unchanged inputs give the same answer', () => {
    const w = widget('kpi', { entity: 'mod_sales', field: 'amount', aggregation: 'sum' })
    const records = RECORDS()
    const e1 = envOf([SALES()], records)
    expect(computeEngineWidget(w, e1)).toEqual(computeEngineWidget(w, e1))
    const e2 = envOf([SALES()], [...records, rec('mod_sales', 's5', { amount: 10, stage: 'open' })])
    expect(as(computeEngineWidget(w, e2), 'value').value).toBe(360.3)
    const trashed = envOf([SALES()], records.map((r) => (r.id === 's1' ? { ...r, deletedAt: '2026-03-11T00:00:00.000Z' } : r)))
    expect(as(computeEngineWidget(w, trashed), 'value').value).toBe(250.2) // trashed records do not count
  })
})

describe('adding a widget: guided defaults are valid for every type', () => {
  beforeEach(() => {
    resetWorld()
    putModules(SALES())
  })
  it.each(WIDGET_KINDS.filter((k) => k !== 'calculation'))('%s', (type) => {
    const w = newWidget(type, useModuleStore.getState().modules)
    expect(w.type).toBe(type)
    expect(w.layout.w).toBeGreaterThanOrEqual(1)
    expect(w.layout.w).toBeLessThanOrEqual(MAX_COLS)
    expect(validateWidget(WS, w, null)).toEqual([])
    const data = computeEngineWidget(w, envOf([SALES()], RECORDS()))
    expect(['error']).not.toContain(data.kind)
  })
  it('a calculation widget needs its calculation and says so; once chosen it is valid', () => {
    const w = newWidget('calculation', useModuleStore.getState().modules)
    expect(validateWidget(WS, w, null).length).toBeGreaterThan(0)
    const inline = finalizeWidget({ ...w, source: { entity: 'mod_sales', field: 'amount', aggregation: 'sum' } }, { mode: 'inline' })
    expect(validateWidget(WS, inline, null)).toEqual([])
  })
  it('rejects a widget that points at a missing field', () => {
    const w = widget('kpi', { entity: 'mod_sales', field: 'nope', aggregation: 'sum' })
    const errors = validateWidget(WS, w, null)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].message).toContain('nope')
  })
  it('date range helpers round-trip', () => {
    expect(buildRange({ preset: 'all' })).toBeUndefined()
    expect(rangeParts('this_month')).toEqual({ preset: 'this_month' })
    expect(rangeParts(buildRange({ preset: 'custom', from: '2026-01-01', to: '2026-02-01' }))).toMatchObject({ preset: 'custom', from: '2026-01-01', to: '2026-02-01' })
  })
})

describe('edit operations (pure)', () => {
  const base = () => {
    let list: DashboardWidgetShape[] = []
    for (const id of ['a', 'b', 'c']) list = addWidget(list, { ...widget('record_count', { entity: 'mod_sales' }), id })
    return list
  }
  const ids = (l: DashboardWidgetShape[]) => sortedWidgets(l).map((w) => w.id)

  it('add / update / remove keep the order contiguous', () => {
    const list = base()
    expect(ids(list)).toEqual(['a', 'b', 'c'])
    expect(sortedWidgets(list).map((w) => w.layout.order)).toEqual([0, 1, 2])
    expect(updateWidget(list, { ...list[1], title: 'Renamed' }).find((w) => w.id === 'b')!.title).toBe('Renamed')
    const removed = removeWidget(list, 'b')
    expect(ids(removed)).toEqual(['a', 'c'])
    expect(removed.map((w) => w.layout.order).sort()).toEqual([0, 1])
  })
  it('duplicate lands right after the original with a new id', () => {
    const list = duplicateWidget(base(), 'a', 'a2')
    expect(ids(list)).toEqual(['a', 'a2', 'b', 'c'])
    expect(list.find((w) => w.id === 'a2')!.title).toMatch(/copy/i)
  })
  it('reorder (drag and drop / keyboard) moves a widget to where another was', () => {
    expect(ids(moveWidget(base(), 'a', 'c'))).toEqual(['b', 'c', 'a'])
    expect(ids(moveWidget(base(), 'c', 'a'))).toEqual(['c', 'a', 'b'])
    expect(ids(moveWidget(base(), 'a', 'a'))).toEqual(['a', 'b', 'c'])
    expect(ids(moveWidget(base(), 'a', 'missing'))).toEqual(['a', 'b', 'c'])
  })
  it('resize clamps width to 1-4 and height to 1-3', () => {
    const list = resizeWidget(base(), 'a', { w: 9, h: 9 })
    expect(list.find((w) => w.id === 'a')!.layout).toMatchObject({ w: MAX_COLS, h: MAX_ROWS })
    const small = resizeWidget(list, 'a', { w: 0, h: -3 })
    expect(small.find((w) => w.id === 'a')!.layout).toMatchObject({ w: 1, h: 1 })
    expect(resizeWidget(base(), 'b', { w: 3 }).find((w) => w.id === 'b')!.layout).toMatchObject({ w: 3, h: 1 })
  })
  it('disable / enable', () => {
    const off = setWidgetEnabled(base(), 'b', false)
    expect(off.find((w) => w.id === 'b')!.enabled).toBe(false)
    expect(setWidgetEnabled(off, 'b', true).find((w) => w.id === 'b')!.enabled).toBe(true)
  })
})

describe('dashboards are saved per workspace AND per user, and survive a reload', () => {
  const store = () => useEngineStore.getState()
  const reload = () => {
    const raw = serializeDocs(store().docs)
    store().setAll([])
    store().setAll(parseDocs(JSON.parse(raw)))
  }
  const shared = () => store().docOf(WS).dashboards.find((d) => d.scope !== 'user')!
  const mine = (userId: string) => store().dashboardsFor(WS, userId)[0]

  beforeEach(() => {
    resetWorld()
    putModules(SALES())
    useRecordStore.getState().setAll(RECORDS())
    ensureDefaultDashboard(WS)
  })

  it('a user without their own layout sees (a copy of) the default', () => {
    const d = store().activeDashboardFor(WS, 'usr_b')!
    expect(d.id).toBe(shared().id)
    expect(d.widgets.length).toBeGreaterThan(0)
    expect(store().dashboardsFor(WS, 'usr_b').map((x) => x.id)).toEqual([shared().id])
  })

  it('add, duplicate, reorder, resize, disable: each is saved for the user, shared default untouched, and reloads', () => {
    const before = JSON.stringify(shared().widgets)
    const d0 = store().activeDashboardFor(WS, 'usr_owner')!
    let widgets = d0.widgets
    const added = { ...newWidget('kpi', useModuleStore.getState().modules, 'w_new'), title: 'My total' }
    widgets = addWidget(widgets, added)
    let saved = saveDashboardLayout(WS, 'usr_owner', d0.id, { widgets }, null)
    expect(saved.errors).toEqual([])
    expect(saved.ok).toBe(true)
    expect(saved.dashboard).toMatchObject({ scope: 'user', userId: 'usr_owner', baseId: d0.id })

    const mineId = saved.dashboard!.id
    widgets = duplicateWidget(saved.dashboard!.widgets, 'w_new', 'w_new2')
    widgets = moveWidget(widgets, 'w_new2', sortedWidgets(widgets)[0].id)
    widgets = resizeWidget(widgets, 'w_new', { w: 4, h: 3 })
    widgets = setWidgetEnabled(widgets, 'w_new2', false)
    saved = saveDashboardLayout(WS, 'usr_owner', mineId, { widgets }, null)
    expect(saved.ok).toBe(true)
    expect(saved.dashboard!.id).toBe(mineId) // updated in place, not forked again

    reload()
    const again = mine('usr_owner')
    expect(again.id).toBe(mineId)
    const list = sortedWidgets(again.widgets)
    expect(list[0].id).toBe('w_new2')
    expect(list[0].enabled).toBe(false)
    expect(list.find((w) => w.id === 'w_new')!.layout).toMatchObject({ w: 4, h: 3 })
    expect(list.map((w) => w.layout.order)).toEqual(list.map((_, i) => i))
    // the shared default is unchanged
    expect(JSON.stringify(shared().widgets)).toBe(before)
  })

  it('different users keep different layouts', () => {
    const base = store().activeDashboardFor(WS, 'usr_owner')!
    const a = saveDashboardLayout(WS, 'usr_owner', base.id, { widgets: removeWidget(base.widgets, base.widgets[0].id) }, null)
    const b = saveDashboardLayout(WS, 'usr_b', base.id, { widgets: base.widgets.slice(0, 2) }, null)
    expect(a.ok && b.ok).toBe(true)
    expect(a.dashboard!.id).not.toBe(b.dashboard!.id)
    expect(store().activeDashboardFor(WS, 'usr_owner')!.widgets).toHaveLength(base.widgets.length - 1)
    expect(store().activeDashboardFor(WS, 'usr_b')!.widgets).toHaveLength(2)
    expect(store().activeDashboardFor(WS, 'usr_c')!.widgets).toHaveLength(base.widgets.length) // never edited: sees the default
    // a user cannot save over somebody else's copy
    const stolen = saveDashboardLayout(WS, 'usr_c', a.dashboard!.id, { widgets: [] }, null)
    expect(stolen.ok).toBe(false)
    expect(store().docOf(WS).dashboards.find((d) => d.id === a.dashboard!.id)!.widgets).toHaveLength(base.widgets.length - 1)
  })

  it('restore default drops the user copy (and only theirs)', () => {
    const base = store().activeDashboardFor(WS, 'usr_owner')!
    const a = saveDashboardLayout(WS, 'usr_owner', base.id, { widgets: base.widgets.slice(0, 1) }, null)
    saveDashboardLayout(WS, 'usr_b', base.id, { widgets: base.widgets.slice(0, 2) }, null)
    expect(hasOwnCopy(store().docOf(WS).dashboards, 'usr_owner', a.dashboard)).toBe(true)
    expect(hasOwnCopy(store().docOf(WS).dashboards, 'usr_owner', base)).toBe(false)
    expect(restoreDefaultDashboard(WS, 'usr_owner', a.dashboard!.id, null)).toEqual({ ok: true })
    reload()
    expect(store().activeDashboardFor(WS, 'usr_owner')!.widgets).toHaveLength(base.widgets.length)
    expect(store().activeDashboardFor(WS, 'usr_b')!.widgets).toHaveLength(2)
    expect(visibleDashboards(store().docOf(WS).dashboards, 'usr_owner').every((d) => d.scope !== 'user')).toBe(true)
  })

  it('personal dashboards: created, private, deleted by restore', () => {
    const created = createUserDashboard(WS, 'usr_owner', 'Mine only', null)
    expect(created.ok).toBe(true)
    expect(visibleDashboards(store().docOf(WS).dashboards, 'usr_owner').map((d) => d.name)).toContain('Mine only')
    expect(visibleDashboards(store().docOf(WS).dashboards, 'usr_b').map((d) => d.name)).not.toContain('Mine only')
    const s = saveDashboardLayout(WS, 'usr_owner', created.dashboard!.id, { widgets: [newWidget('record_count', useModuleStore.getState().modules)] }, null)
    expect(s.ok).toBe(true)
    expect(restoreDefaultDashboard(WS, 'usr_owner', created.dashboard!.id, null).ok).toBe(true)
    expect(store().docOf(WS).dashboards.some((d) => d.name === 'Mine only')).toBe(false)
  })

  it('view-only users cannot edit; an invalid layout is refused and nothing is saved', () => {
    const base = store().activeDashboardFor(WS, 'usr_owner')!
    const viewer = roleById('role_viewer')
    const denied = saveDashboardLayout(WS, 'usr_owner', base.id, { widgets: [] }, viewer)
    expect(denied.ok).toBe(false)
    expect(denied.errors[0].path).toBe('(permission)')
    expect(restoreDefaultDashboard(WS, 'usr_owner', base.id, viewer).ok).toBe(false)
    expect(createUserDashboard(WS, 'usr_owner', 'x', viewer).ok).toBe(false)
    const manager = roleById('role_manager')
    expect(saveDashboardLayout(WS, 'usr_owner', base.id, { widgets: base.widgets }, manager).ok).toBe(true)

    const before = JSON.stringify(store().docs)
    const bad = saveDashboardLayout(WS, 'usr_b', base.id, { widgets: [widget('kpi', { entity: 'mod_sales', field: 'nope', aggregation: 'sum' })] }, null)
    expect(bad.ok).toBe(false)
    expect(bad.errors.length).toBeGreaterThan(0)
    expect(store().dashboardsFor(WS, 'usr_b').every((d) => d.scope !== 'user')).toBe(true)
    expect(JSON.stringify(store().docs).length).toBe(before.length)
  })
})

describe('a brand-new project opens its Overview with live data', () => {
  const computeAll = (ws: string) => {
    const modules = useModuleStore.getState().modules.filter((m) => m.workspaceId === ws)
    const records = useRecordStore.getState().records.filter((r) => r.workspaceId === ws)
    const dash = useEngineStore.getState().activeDashboardFor(ws, 'usr_owner')!
    const e = envOf(modules, records)
    return { dash, modules, records, data: dash.widgets.map((w) => ({ w, d: computeEngineWidget(w, e) })) }
  }

  it('blank project: an Overview exists, empty, and fills in as modules and records are added', () => {
    resetWorld()
    const ws = createWorkspace({ name: 'Fresh', kind: 'project', switchTo: false }).id
    expect(useEngineStore.getState().activeDashboardFor(ws, 'usr_owner')).toMatchObject({ name: 'Overview', isDefault: true })
    expect(computeAll(ws).data).toEqual([])
    const m = { ...SALES(), workspaceId: ws }
    useModuleStore.getState().setAll([...useModuleStore.getState().modules, m])
    useRecordStore.getState().setAll(RECORDS().map((r) => ({ ...r, workspaceId: ws })))
    ensureDefaultDashboard(ws) // what opening the page does
    const { data } = computeAll(ws)
    expect(data.length).toBeGreaterThan(3)
    expect(data.filter((x) => x.d.kind === 'error')).toEqual([])
    const count = data.find((x) => x.w.type === 'record_count')!.d as Extract<WidgetData, { kind: 'value' }>
    expect(count.value).toBe(4)
    const total = data.find((x) => x.w.type === 'kpi')!.d as Extract<WidgetData, { kind: 'value' }>
    expect(total.value).toBe(350.3)
  })

  it('template project: every Overview widget computes (no errors) and counts match the installed records', () => {
    resetWorld()
    const tpl = BUILTIN_TEMPLATES[0]
    const ws = createWorkspace({ name: 'From template', kind: 'project', template: tpl, switchTo: false }).id
    const { dash, modules, records, data } = computeAll(ws)
    expect(modules.length).toBeGreaterThan(0)
    expect(dash.widgets.length).toBeGreaterThan(0)
    expect(data.filter((x) => x.d.kind === 'error')).toEqual([])
    for (const { w, d } of data) {
      if (w.type !== 'record_count') continue
      expect((d as Extract<WidgetData, { kind: 'value' }>).value).toBe(records.filter((r) => r.moduleId === w.source!.entity && !r.deletedAt && !r.archived).length)
    }
  })
})

describe('render (server-side smoke)', () => {
  const widgets = [
    { ...widget('record_count', { entity: 'mod_sales' }), id: 'g1', title: 'Deals', layout: { w: 1, h: 1, order: 0 } },
    { ...widget('bar_chart', { entity: 'mod_sales', groupBy: 'stage' }), id: 'g2', title: 'By stage', layout: { w: 2, h: 2, order: 1 } },
    { ...widget('kpi', { entity: 'mod_sales', field: 'amount' }), id: 'g3', title: 'Hidden one', enabled: false, layout: { w: 1, h: 1, order: 2 } },
  ]
  const noop = () => {}

  it('a widget starts as a skeleton (loading state) and never throws on a bad source', () => {
    const html = renderToStaticMarkup(<EngineWidgetView widget={widgets[0]} ws={WS} />)
    expect(html).toContain('aria-busy="true"')
    expect(() => renderToStaticMarkup(<EngineWidgetView widget={{ ...widgets[0], source: { entity: 'mod_gone' } }} ws={WS} />)).not.toThrow()
  })

  it('the grid is responsive (1 / 2 / 4 columns), hides disabled widgets in view mode, and shows edit controls in edit mode', () => {
    const view = renderToStaticMarkup(<EngineDashboardGrid ws={WS} widgets={widgets} editing={false} onChange={noop} onConfigure={noop} />)
    expect(view).toContain('grid-cols-1')
    expect(view).toContain('sm:grid-cols-2')
    expect(view).toContain('lg:grid-cols-4')
    expect(view).toContain('Deals')
    expect(view).toContain('By stage')
    expect(view).not.toContain('Hidden one')
    expect(view).not.toMatch(/aria-label="Drag/i)

    const edit = renderToStaticMarkup(<EngineDashboardGrid ws={WS} widgets={widgets} editing onChange={noop} onConfigure={noop} />)
    expect(edit).toContain('Hidden one')
    expect(edit).toMatch(/aria-label="Drag/i)
    expect(edit).toMatch(/aria-label="[^"]*(size|Size)/)
  })
})
