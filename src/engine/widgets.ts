import { Decimal } from '#/genius/formula/decimal'
import type { CrmRecord, Module } from '#/types'
import { numberOf, runAggregate, type AggQuery, type AggResult } from './aggregate'
import { formatOfField, runCalculation } from './calc'
import { EngineError, inWindow, isDateField, liveRecordsOf, readField, resolveField, resolveModule, resolveRange, toDate, type EngineEnv } from './resolve'
import { evalConditions } from './rules'
import type { Calculation, ConditionNode, DashboardWidgetShape, WidgetFormat, WidgetKind } from './schema'

/**
 * Widget config -> data. The ONE place that turns a dashboard widget (engine/schema.ts) into numbers, series or rows, using
 * engine/aggregate.ts (memoised) so the dashboard, the tests and any future export agree. Pure: no stores, no React.
 */

export interface SeriesPoint {
  key: string
  name: string
  value: number
  count: number
  color?: string
}

export type WidgetData =
  | { kind: 'value'; value: number | null; count: number; format: WidgetFormat; caption?: string }
  | { kind: 'profit'; income: number; expense: number; profit: number; format: WidgetFormat }
  | { kind: 'percentage'; value: number | null; matched: number; total: number }
  | { kind: 'progress'; value: number; target: number; pct: number; format: WidgetFormat }
  | { kind: 'series'; points: SeriesPoint[]; total: number; format: WidgetFormat; donut: boolean }
  | { kind: 'rows'; module: Module; records: CrmRecord[] }
  | { kind: 'activity'; limit: number }
  | { kind: 'empty'; hint: string }
  | { kind: 'error'; message: string }

export interface WidgetOptions {
  /** saved calculations (for `calculation` widgets that name one) */
  calculations?: Calculation[]
  /** modules the person may not see are shown as "no access" instead of numbers */
  canView?: (moduleId: string) => boolean
}

export const WIDGET_LABELS: Record<WidgetKind, { label: string; hint: string; icon: string }> = {
  kpi: { label: 'Total / KPI', hint: 'Sum, average, min or max of a field', icon: 'Sigma' },
  revenue: { label: 'Revenue', hint: 'Money coming in, with a trend', icon: 'TrendingUp' },
  profit_loss: { label: 'Profit / loss', hint: 'Income minus expenses', icon: 'Scale' },
  record_count: { label: 'Record count', hint: 'How many records match', icon: 'Hash' },
  average: { label: 'Average', hint: 'Average of a number field', icon: 'Gauge' },
  percentage: { label: 'Percentage', hint: 'Share of records that match a filter', icon: 'Percent' },
  progress: { label: 'Progress bar', hint: 'A total against a target', icon: 'Target' },
  line_chart: { label: 'Line chart', hint: 'A value over time', icon: 'LineChart' },
  bar_chart: { label: 'Bar chart', hint: 'Compare groups', icon: 'BarChart3' },
  pie_chart: { label: 'Pie chart', hint: 'Share of each group', icon: 'PieChart' },
  doughnut_chart: { label: 'Doughnut chart', hint: 'Share of each group, with a total', icon: 'PieChart' },
  table: { label: 'Table', hint: 'The newest records of a module', icon: 'Table2' },
  recent_activity: { label: 'Recent activity', hint: 'What changed lately', icon: 'History' },
  recent_records: { label: 'Recent records', hint: 'The newest records', icon: 'Clock' },
  status_breakdown: { label: 'Status breakdown', hint: 'Records per status', icon: 'ListChecks' },
  conditional_stat: { label: 'Conditional statistic', hint: 'A number for the records that match a condition', icon: 'Filter' },
  calculation: { label: 'Custom calculation', hint: 'A saved or inline calculation', icon: 'Calculator' },
}

/** which widget types need which pieces of the source (the dialog uses this to show only what applies) */
export const WIDGET_NEEDS: Record<WidgetKind, { module: boolean; field: 'none' | 'optional' | 'required'; aggregation: boolean; groupBy: boolean; expense: boolean; target: boolean; filters: boolean; range: boolean }> = {
  kpi: { module: true, field: 'optional', aggregation: true, groupBy: false, expense: false, target: false, filters: true, range: true },
  revenue: { module: true, field: 'required', aggregation: false, groupBy: false, expense: false, target: false, filters: true, range: true },
  profit_loss: { module: true, field: 'required', aggregation: false, groupBy: false, expense: true, target: false, filters: true, range: true },
  record_count: { module: true, field: 'none', aggregation: false, groupBy: false, expense: false, target: false, filters: true, range: true },
  average: { module: true, field: 'required', aggregation: false, groupBy: false, expense: false, target: false, filters: true, range: true },
  percentage: { module: true, field: 'none', aggregation: false, groupBy: false, expense: false, target: false, filters: true, range: true },
  progress: { module: true, field: 'optional', aggregation: true, groupBy: false, expense: false, target: true, filters: true, range: true },
  line_chart: { module: true, field: 'optional', aggregation: true, groupBy: true, expense: false, target: false, filters: true, range: true },
  bar_chart: { module: true, field: 'optional', aggregation: true, groupBy: true, expense: false, target: false, filters: true, range: true },
  pie_chart: { module: true, field: 'optional', aggregation: true, groupBy: true, expense: false, target: false, filters: true, range: true },
  doughnut_chart: { module: true, field: 'optional', aggregation: true, groupBy: true, expense: false, target: false, filters: true, range: true },
  table: { module: true, field: 'none', aggregation: false, groupBy: false, expense: false, target: false, filters: true, range: true },
  recent_activity: { module: false, field: 'none', aggregation: false, groupBy: false, expense: false, target: false, filters: false, range: false },
  recent_records: { module: true, field: 'none', aggregation: false, groupBy: false, expense: false, target: false, filters: true, range: true },
  status_breakdown: { module: true, field: 'none', aggregation: false, groupBy: true, expense: false, target: false, filters: true, range: true },
  conditional_stat: { module: true, field: 'optional', aggregation: true, groupBy: false, expense: false, target: false, filters: true, range: true },
  calculation: { module: false, field: 'none', aggregation: false, groupBy: false, expense: false, target: false, filters: false, range: false },
}

const CHARTS = new Set<WidgetKind>(['line_chart', 'bar_chart', 'pie_chart', 'doughnut_chart', 'status_breakdown'])

const num = (d: Parameters<typeof numberOf>[0]) => numberOf(d) ?? 0

function queryOf(w: DashboardWidgetShape, module: Module, over: Partial<AggQuery> = {}): AggQuery {
  const s = w.source ?? {}
  return { entity: module.id, agg: s.aggregation ?? (s.field ? 'sum' : 'count'), field: s.field, filters: s.filters, groupBy: s.groupBy, dateField: s.dateField, dateRange: s.dateRange, ...over }
}

function formatFor(w: DashboardWidgetShape, module: Module | undefined, fieldRef: string | undefined): WidgetFormat {
  if (w.format) return w.format
  const f = module && fieldRef ? resolveField(module, fieldRef) : undefined
  return f ? formatOfField(f) : { kind: 'number' }
}

/** records of a module that match the widget's filters and date window, newest first */
export function selectRecords(env: EngineEnv, module: Module, w: DashboardWidgetShape): CrmRecord[] {
  const s = w.source ?? {}
  const win = resolveRange(s.dateRange, env.now)
  const dateRef = s.dateField ?? (typeof s.dateRange === 'object' ? s.dateRange.field : undefined) ?? '__createdAt'
  const dateField = resolveField(module, dateRef)
  const rc = { module, env } as { module: Module; env: EngineEnv; record: CrmRecord }
  const out = liveRecordsOf(env, module.id).filter((r) => {
    if ((win.from || win.to) && !inWindow(dateField ? toDate(readField(module, r, dateField, env)) : null, win)) return false
    if (s.filters?.length) {
      rc.record = r
      if (!evalConditions(s.filters as ConditionNode[], 'AND', rc)) return false
    }
    return true
  })
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

function series(w: DashboardWidgetShape, res: AggResult, format: WidgetFormat): WidgetData {
  const points = res.groups.map((g) => ({ key: g.key, name: g.label, value: num(g.value), count: g.count, color: g.color }))
  return { kind: 'series', points, total: points.reduce((a, p) => a + p.value, 0), format, donut: w.type === 'doughnut_chart' || w.type === 'status_breakdown' }
}

/** Compute what a widget shows. Never throws: problems come back as { kind: 'error' } so one bad widget cannot break the page. */
export function computeEngineWidget(w: DashboardWidgetShape, env: EngineEnv, opts: WidgetOptions = {}): WidgetData {
  try {
    return compute(w, env, opts)
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) }
  }
}

function compute(w: DashboardWidgetShape, env: EngineEnv, opts: WidgetOptions): WidgetData {
  if (w.type === 'recent_activity') return { kind: 'activity', limit: w.limit ?? 8 }
  if (w.type === 'calculation') return computeCalculation(w, env, opts)
  const s = w.source
  if (!s?.entity) return { kind: 'empty', hint: 'Choose a module for this widget.' }
  const module = resolveModule(env.modules, s.entity)
  if (!module) throw new EngineError(`Module "${s.entity}" no longer exists`)
  if (opts.canView && !opts.canView(module.id)) return { kind: 'empty', hint: `You do not have access to ${module.name}.` }

  switch (w.type) {
    case 'record_count': {
      const r = runAggregate(env, queryOf(w, module, { agg: 'count', field: undefined, groupBy: undefined }))
      return { kind: 'value', value: r.count, count: r.count, format: w.format ?? { kind: 'number', precision: 0 }, caption: r.count === 1 ? 'record' : 'records' }
    }
    case 'kpi':
    case 'average':
    case 'revenue':
    case 'conditional_stat': {
      const agg = w.type === 'average' ? 'average' : w.type === 'revenue' ? 'sum' : (s.aggregation ?? (s.field ? 'sum' : 'count'))
      const field = agg === 'count' && w.type !== 'revenue' ? undefined : s.field
      const r = runAggregate(env, queryOf(w, module, { agg, field, groupBy: undefined }))
      const format = agg === 'count' ? (w.format ?? { kind: 'number', precision: 0 }) : formatFor(w, module, s.field)
      const label = resolveField(module, s.field)?.label
      return { kind: 'value', value: agg === 'count' ? r.count : numberOf(r.value), count: r.count, format, caption: agg === 'count' ? 'records' : `${agg === 'average' ? 'average' : agg} of ${label ?? 'field'} · ${r.count} records` }
    }
    case 'profit_loss': {
      const income = runAggregate(env, queryOf(w, module, { agg: 'sum', groupBy: undefined }))
      const expense = runAggregate(env, queryOf(w, module, { agg: 'sum', field: s.expenseField, groupBy: undefined }))
      const i = num(income.value)
      const x = num(expense.value)
      return { kind: 'profit', income: i, expense: x, profit: income.value && expense.value ? num(income.value.sub(expense.value)) : i - x, format: formatFor(w, module, s.field) }
    }
    case 'percentage': {
      const total = runAggregate(env, queryOf(w, module, { agg: 'count', field: undefined, groupBy: undefined, filters: undefined }))
      const matched = runAggregate(env, queryOf(w, module, { agg: 'count', field: undefined, groupBy: undefined }))
      return { kind: 'percentage', value: total.count ? Math.round((matched.count / total.count) * 1000) / 10 : null, matched: matched.count, total: total.count }
    }
    case 'progress': {
      const agg = s.aggregation ?? (s.field ? 'sum' : 'count')
      const r = runAggregate(env, queryOf(w, module, { agg, field: agg === 'count' ? undefined : s.field, groupBy: undefined }))
      const value = agg === 'count' ? r.count : num(r.value)
      const target = w.target ?? 0
      if (!target) return { kind: 'empty', hint: 'Set a target for this progress bar.' }
      return { kind: 'progress', value, target, pct: Math.min(100, Math.round((value / target) * 100)), format: agg === 'count' ? { kind: 'number', precision: 0 } : formatFor(w, module, s.field) }
    }
    case 'table':
    case 'recent_records':
      return { kind: 'rows', module, records: selectRecords(env, module, w).slice(0, w.limit ?? (w.type === 'table' ? 8 : 6)) }
    default:
      break
  }
  if (CHARTS.has(w.type)) {
    let groupBy = s.groupBy
    const range = s.dateRange
    let bucket = typeof range === 'object' ? range.bucket : undefined
    if (w.type === 'line_chart') {
      const g = groupBy ? resolveField(module, groupBy) : undefined
      if (!g || !isDateField(g)) {
        // a line needs time on the x axis: group by the created date unless the source names a date field
        groupBy = s.dateField ?? '__createdAt'
        bucket = bucket ?? 'month'
      }
    }
    if (!groupBy) {
      const choice = module.fields.find((f) => (f.type === 'dropdown' || f.type === 'radio') && f.options?.length)
      if (!choice) return { kind: 'empty', hint: 'Choose a "group by" field for this chart.' }
      groupBy = choice.id
    }
    const agg = s.aggregation ?? (s.field ? 'sum' : 'count')
    const dateRange = bucket ? (typeof range === 'object' ? { ...range, bucket } : { preset: range ?? 'all', bucket }) : range
    const res = runAggregate(env, queryOf(w, module, { agg, field: agg === 'count' ? undefined : s.field, groupBy, dateRange: dateRange as AggQuery['dateRange'], bucket, limit: 24 }))
    return series(w, res, agg === 'count' ? { kind: 'number', precision: 0 } : formatFor(w, module, s.field))
  }
  return { kind: 'empty', hint: 'This widget type is not supported.' }
}

function computeCalculation(w: DashboardWidgetShape, env: EngineEnv, opts: WidgetOptions): WidgetData {
  const ref = w.calculation
  if (!ref) return { kind: 'empty', hint: 'Choose a calculation for this widget.' }
  const body = typeof ref === 'string' ? opts.calculations?.find((c) => c.id === ref || c.name === ref) : ref
  if (!body) throw new EngineError(`Calculation "${String(ref)}" no longer exists`)
  const module = resolveModule(env.modules, body.entity)
  if (!module) throw new EngineError(`Module "${body.entity}" no longer exists`)
  if (opts.canView && !opts.canView(module.id)) return { kind: 'empty', hint: `You do not have access to ${module.name}.` }
  const aggregate = { ...body, scope: 'aggregate' as const }
  const res = runCalculation(aggregate, env)
  const format = w.format ?? (body.output?.type === 'currency' ? { kind: 'currency' as const, currency: body.output.currency } : body.output?.type === 'percentage' ? { kind: 'percent' as const } : { kind: 'number' as const })
  if (res.groups) return { kind: 'series', points: res.groups.map((g) => ({ key: g.key, name: g.label, value: num(g.value), count: g.count, color: g.color })), total: res.groups.reduce((a, g) => a + num(g.value), 0), format, donut: false }
  const v = res.value
  return { kind: 'value', value: v instanceof Decimal ? v.toNumber() : null, count: 0, format, caption: body.name }
}
