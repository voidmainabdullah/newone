import type { Dashboard, Field, Module, Widget } from '#/types'
import { useDashboardStore } from '#/stores/collections'
import { useEngineStore } from '#/stores/engineStore'
import { useModuleStore } from '#/stores/moduleStore'
import { nowIso } from '#/utils/id'
import type { DashboardBody, DashboardWidgetShape } from './schema'

/**
 * The default "Overview" dashboard every project gets, built from the project's REAL modules and fields:
 * a record count per module, the total and average of the first money / number field, a status breakdown of the first
 * choice field, the newest records, and records created over time.
 *
 * `buildDefaultDashboard` is pure. `ensureDefaultDashboard` is the ONE function every path calls (new project, template,
 * blank project, Studio publish/apply, and the Dashboards page when it finds none): it saves the config in the engine store
 * and is idempotent. While the dashboard is `autoManaged` (nobody edited it) it is rebuilt when modules change.
 * The existing Dashboards page keeps working: the same widgets are mirrored into its legacy collection when it has none.
 */

export const DEFAULT_DASHBOARD_NAME = 'Overview'
const MAX_COUNT_WIDGETS = 6
const isChoice = (f: Field) => (f.type === 'dropdown' || f.type === 'radio') && !!f.options?.length
export const isChoiceField = isChoice
const isMoney = (f: Field) => f.type === 'currency'
const isNum = (f: Field) => f.type === 'number' || f.type === 'percentage'

export function buildDefaultDashboard(_workspaceId: string, modules: Module[]): DashboardBody {
  const mods = modules.filter((m) => !m.archived && !m.system).sort((a, b) => a.order - b.order)
  const widgets: DashboardWidgetShape[] = []
  const add = (w: Omit<DashboardWidgetShape, 'layout' | 'enabled'> & { w?: number; h?: number }) => {
    const { w: width, h: height, ...rest } = w
    widgets.push({ ...rest, enabled: true, layout: { w: width ?? 1, h: height ?? 1, order: widgets.length } })
  }
  for (const m of mods.slice(0, MAX_COUNT_WIDGETS)) add({ id: `ov_count_${m.id}`, type: 'record_count', title: m.name, source: { entity: m.id, aggregation: 'count' } })

  // first money field (else first number field) across modules
  let pick: { m: Module; f: Field } | undefined
  for (const pass of [isMoney, isNum]) {
    for (const m of mods) {
      const f = m.fields.find(pass)
      if (f) { pick = { m, f }; break }
    }
    if (pick) break
  }
  if (pick) {
    const format = pick.f.type === 'currency' ? ({ kind: 'currency', currency: pick.f.currency } as const) : pick.f.type === 'percentage' ? ({ kind: 'percent' } as const) : ({ kind: 'number' } as const)
    add({ id: `ov_sum_${pick.m.id}_${pick.f.id}`, type: 'kpi', title: `Total ${pick.f.label}`, source: { entity: pick.m.id, field: pick.f.id, aggregation: 'sum' }, format })
    add({ id: `ov_avg_${pick.m.id}_${pick.f.id}`, type: 'average', title: `Average ${pick.f.label}`, source: { entity: pick.m.id, field: pick.f.id, aggregation: 'average' }, format })
  }
  const status = mods.map((m) => ({ m, f: m.fields.find(isChoice) })).find((x) => x.f)
  if (status?.f) add({ id: `ov_status_${status.m.id}`, type: 'status_breakdown', title: `${status.m.name} by ${status.f.label}`, source: { entity: status.m.id, groupBy: status.f.id, aggregation: 'count' }, w: 2, h: 2 })
  const first = mods[0]
  if (first) {
    add({ id: `ov_time_${first.id}`, type: 'line_chart', title: `${first.name} over time`, source: { entity: first.id, aggregation: 'count', groupBy: '__createdAt', dateRange: { preset: 'all', bucket: 'month' } }, w: 2, h: 2 })
    add({ id: `ov_recent_${first.id}`, type: 'recent_records', title: `Recent ${first.name}`, source: { entity: first.id }, limit: 6, w: 2, h: 2 })
  }
  return { type: 'dashboard', name: DEFAULT_DASHBOARD_NAME, scope: 'workspace', isDefault: true, autoManaged: true, enabled: true, widgets }
}

/** Engine widgets -> the legacy Widget the existing Dashboards page renders (types without a legacy equivalent are left out). */
export function toLegacyWidgets(d: Pick<DashboardBody, 'widgets'>): Widget[] {
  const out: Widget[] = []
  for (const w of d.widgets) {
    if (w.enabled === false || !w.source?.entity) continue
    const s = w.source
    const base = { id: w.id, title: w.title, moduleId: s.entity, fieldId: s.field, groupBy: s.groupBy, dateRange: 'all' as const, filters: [], w: Math.min(4, Math.max(1, w.layout.w)) as Widget['w'], h: Math.min(3, Math.max(1, w.layout.h)) as Widget['h'], limit: w.limit }
    switch (w.type) {
      case 'record_count': out.push({ ...base, type: 'stat', agg: 'count' }); break
      case 'kpi': out.push({ ...base, type: 'metric', agg: s.aggregation === 'average' ? 'avg' : (s.aggregation ?? 'sum') === 'count' ? 'count' : (s.aggregation ?? 'sum') as 'sum' | 'min' | 'max' }); break
      case 'average': out.push({ ...base, type: 'metric', agg: 'avg' }); break
      case 'status_breakdown':
      case 'pie_chart':
      case 'doughnut_chart': out.push({ ...base, type: 'pie', agg: 'count' }); break
      case 'bar_chart': out.push({ ...base, type: 'bar', agg: 'count' }); break
      case 'line_chart': out.push({ ...base, type: 'line', agg: 'count', dateField: '__createdAt' }); break
      case 'recent_records': out.push({ ...base, type: 'recentRecords', agg: 'count' }); break
      case 'table': out.push({ ...base, type: 'table', agg: 'count' }); break
      case 'revenue': out.push({ ...base, type: 'revenue', agg: 'sum' }); break
    }
  }
  return out
}

const legacyIdFor = (ws: string) => `dash_overview_${ws}`

/**
 * Make sure the workspace has its "Overview" dashboard in the engine store (and mirrored for the Dashboards page).
 * Safe to call any number of times, from any path; returns the dashboard id.
 */
export function ensureDefaultDashboard(ws: string, modulesIn?: Module[]): string {
  const modules = (modulesIn ?? useModuleStore.getState().modules).filter((m) => m.workspaceId === ws)
  const store = useEngineStore.getState()
  const body = buildDefaultDashboard(ws, modules)
  const doc = store.docOf(ws)
  const shared = doc.dashboards.filter((d) => d.scope !== 'user')
  const existing = shared.find((d) => d.isDefault) ?? shared.find((d) => d.name === DEFAULT_DASHBOARD_NAME)
  let id: string
  if (!existing) id = store.add(ws, 'dashboards', body).id
  else {
    id = existing.id
    if (existing.autoManaged && JSON.stringify(existing.widgets) !== JSON.stringify(body.widgets)) store.update(ws, 'dashboards', existing.id, { widgets: body.widgets, autoManaged: true })
  }
  mirrorToLegacy(ws, body)
  return id
}

function mirrorToLegacy(ws: string, body: DashboardBody) {
  const legacy = useDashboardStore.getState()
  const mine = legacy.items.find((d) => d.id === legacyIdFor(ws))
  const widgets = toLegacyWidgets(body)
  if (mine) {
    // refresh our own mirror until somebody adds widgets of their own
    if (mine.widgets.every((w) => w.id.startsWith('ov_')) && JSON.stringify(mine.widgets) !== JSON.stringify(widgets)) legacy.update(mine.id, { widgets })
    return
  }
  if (!widgets.length || legacy.items.some((d) => d.workspaceId === ws)) return // nothing to show yet; templates and users keep their own dashboards
  const t = nowIso()
  const d: Dashboard = { id: legacyIdFor(ws), workspaceId: ws, name: DEFAULT_DASHBOARD_NAME, widgets, createdAt: t, updatedAt: t }
  legacy.add(d)
}
