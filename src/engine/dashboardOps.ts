import type { Module } from '#/types'
import { uid } from '#/utils/id'
import { isChoiceField } from './defaultDashboard'
import type { DashboardWidgetShape, WidgetKind } from './schema'
import { WIDGET_LABELS } from './widgets'

/**
 * Editing a dashboard layout. Pure functions over a widget list: every edit returns a NEW list with `layout.order`
 * renumbered 0..n-1, so what is saved is always exactly what is shown. The dashboard page applies one of these and saves.
 */

export const MAX_COLS = 4
export const MAX_ROWS = 3
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n) || lo))

export const sortedWidgets = (list: DashboardWidgetShape[]): DashboardWidgetShape[] => [...list].sort((a, b) => a.layout.order - b.layout.order)

export const renumber = (list: DashboardWidgetShape[]): DashboardWidgetShape[] => list.map((w, i) => (w.layout.order === i ? w : { ...w, layout: { ...w.layout, order: i } }))

const SIZE: Partial<Record<WidgetKind, { w: number; h: number }>> = {
  line_chart: { w: 2, h: 2 },
  bar_chart: { w: 2, h: 2 },
  pie_chart: { w: 2, h: 2 },
  doughnut_chart: { w: 2, h: 2 },
  status_breakdown: { w: 2, h: 2 },
  table: { w: 2, h: 2 },
  recent_records: { w: 2, h: 2 },
  recent_activity: { w: 2, h: 2 },
  revenue: { w: 2, h: 1 },
  profit_loss: { w: 2, h: 1 },
}

const isMoney = (m: Module) => m.fields.find((f) => f.type === 'currency')
const isNum = (m: Module) => m.fields.find((f) => f.type === 'number' || f.type === 'percentage')

/** A new widget of `type` with a sensible source taken from the project's real modules. */
export function newWidget(type: WidgetKind, modules: Module[], id = uid('w')): DashboardWidgetShape {
  const mods = modules.filter((m) => !m.archived && !m.system)
  const m = mods[0] ?? modules[0]
  const num = m ? (isMoney(m) ?? isNum(m)) : undefined
  const choice = m?.fields.find(isChoiceField)
  const size = SIZE[type] ?? { w: 1, h: 1 }
  const base = { id, type, title: WIDGET_LABELS[type].label, enabled: true, layout: { ...size, order: 1000 } } // the schema's highest order: sorts last until addWidget renumbers
  const fmt = num?.type === 'currency' ? { kind: 'currency' as const, currency: num.currency } : num?.type === 'percentage' ? { kind: 'percent' as const } : undefined
  const source = (extra: Record<string, unknown> = {}) => ({ entity: m?.id, ...extra })
  switch (type) {
    case 'record_count': return { ...base, title: m ? `${m.name} count` : base.title, source: source({ aggregation: 'count' }) }
    case 'kpi': return { ...base, title: num ? `Total ${num.label}` : base.title, source: source(num ? { field: num.id, aggregation: 'sum' } : { aggregation: 'count' }), ...(fmt ? { format: fmt } : {}) }
    case 'average': return { ...base, title: num ? `Average ${num.label}` : base.title, source: source({ field: num?.id, aggregation: 'average' }), ...(fmt ? { format: fmt } : {}) }
    case 'revenue': return { ...base, title: num ? `${num.label} revenue` : base.title, source: source({ field: num?.id, aggregation: 'sum' }), ...(fmt ? { format: fmt } : {}) }
    case 'profit_loss': {
      const money = m?.fields.filter((f) => f.type === 'currency') ?? []
      return { ...base, source: source({ field: money[0]?.id, expenseField: money[1]?.id, aggregation: 'sum' }), ...(fmt ? { format: fmt } : {}) }
    }
    case 'percentage': return { ...base, title: 'Share of records', source: source({ aggregation: 'count', filters: choice?.options?.[0] ? [{ field: choice.id, operator: 'equal', value: choice.options[0].id }] : [] }) }
    case 'progress': return { ...base, title: 'Progress to target', target: 100, source: source(num ? { field: num.id, aggregation: 'sum' } : { aggregation: 'count' }), ...(fmt ? { format: fmt } : {}) }
    case 'line_chart': return { ...base, title: m ? `${m.name} over time` : base.title, source: source({ aggregation: 'count', groupBy: '__createdAt', dateRange: { preset: 'all', bucket: 'month' } }) }
    case 'bar_chart':
    case 'pie_chart':
    case 'doughnut_chart':
    case 'status_breakdown': return { ...base, title: m && choice ? `${m.name} by ${choice.label}` : base.title, source: source({ aggregation: 'count', groupBy: choice?.id }) }
    case 'table':
    case 'recent_records': return { ...base, title: m ? `Recent ${m.name}` : base.title, limit: 6, source: source() }
    case 'conditional_stat': return { ...base, source: source({ aggregation: 'count', filters: choice?.options?.[0] ? [{ field: choice.id, operator: 'equal', value: choice.options[0].id }] : [] }) }
    case 'calculation': return { ...base }
    case 'recent_activity': return { ...base, limit: 8 }
  }
}

export function addWidget(list: DashboardWidgetShape[], w: DashboardWidgetShape): DashboardWidgetShape[] {
  return renumber([...sortedWidgets(list), { ...w, layout: { ...w.layout, order: list.length } }])
}

export function updateWidget(list: DashboardWidgetShape[], w: DashboardWidgetShape): DashboardWidgetShape[] {
  return renumber(sortedWidgets(list).map((x) => (x.id === w.id ? { ...w, layout: x.layout } : x)))
}

export function removeWidget(list: DashboardWidgetShape[], id: string): DashboardWidgetShape[] {
  return renumber(sortedWidgets(list).filter((w) => w.id !== id))
}

/** a copy placed right after the original, with a new id */
export function duplicateWidget(list: DashboardWidgetShape[], id: string, newId = uid('w')): DashboardWidgetShape[] {
  const sorted = sortedWidgets(list)
  const i = sorted.findIndex((w) => w.id === id)
  if (i < 0) return list
  const src = sorted[i]
  const copy: DashboardWidgetShape = { ...structuredClone(src), id: newId, title: `${src.title} (copy)` }
  return renumber([...sorted.slice(0, i + 1), copy, ...sorted.slice(i + 1)])
}

/** drag-and-drop / keyboard reorder: `id` takes the place of `overId` */
export function moveWidget(list: DashboardWidgetShape[], id: string, overId: string): DashboardWidgetShape[] {
  const sorted = sortedWidgets(list)
  const from = sorted.findIndex((w) => w.id === id)
  const to = sorted.findIndex((w) => w.id === overId)
  if (from < 0 || to < 0 || from === to) return list
  const next = [...sorted]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return renumber(next)
}

export function resizeWidget(list: DashboardWidgetShape[], id: string, size: { w?: number; h?: number }): DashboardWidgetShape[] {
  return renumber(sortedWidgets(list).map((x) => (x.id === id ? { ...x, layout: { ...x.layout, w: clamp(size.w ?? x.layout.w, 1, MAX_COLS), h: clamp(size.h ?? x.layout.h, 1, MAX_ROWS) } } : x)))
}

export function setWidgetEnabled(list: DashboardWidgetShape[], id: string, enabled: boolean): DashboardWidgetShape[] {
  return renumber(sortedWidgets(list).map((x) => (x.id === id ? { ...x, enabled } : x)))
}
