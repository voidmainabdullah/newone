import type { Aggregation, CalculationBody, DashboardWidgetShape, DateRangeSpec, Preset, WidgetSource } from './schema'

/**
 * Small pure helpers behind the "add / edit widget" dialog, so the form's logic is testable without a browser.
 */

export interface RangeParts {
  preset: Preset
  from?: string
  to?: string
  field?: string
  bucket?: 'day' | 'week' | 'month' | 'year'
}

export const rangeParts = (r: DateRangeSpec | undefined): RangeParts => (!r ? { preset: 'all' } : typeof r === 'string' ? { preset: r } : { ...r })

/** the smallest config that says the same thing: a plain preset name when nothing else is set */
export function buildRange(p: RangeParts): DateRangeSpec | undefined {
  const custom = p.preset === 'custom'
  const extra = { ...(custom && p.from ? { from: p.from } : {}), ...(custom && p.to ? { to: p.to } : {}), ...(p.field ? { field: p.field } : {}), ...(p.bucket ? { bucket: p.bucket } : {}) }
  if (!Object.keys(extra).length) return p.preset === 'all' ? undefined : p.preset
  return { preset: p.preset, ...extra }
}

export const RANGE_OPTIONS: { id: Preset; label: string }[] = [
  { id: 'all', label: 'All time' },
  { id: 'today', label: 'Today' },
  { id: 'this_week', label: 'This week' },
  { id: 'this_month', label: 'This month' },
  { id: 'last_month', label: 'Last month' },
  { id: 'last_7_days', label: 'Last 7 days' },
  { id: 'last_30_days', label: 'Last 30 days' },
  { id: 'last_90_days', label: 'Last 90 days' },
  { id: 'this_year', label: 'This year' },
  { id: 'custom', label: 'Custom range' },
]

const OP_FOR: Record<Aggregation, CalculationBody['operation']> = { count: 'count', sum: 'sum', average: 'average', min: 'min', max: 'max' }
const AGG_FOR: Partial<Record<CalculationBody['operation'], Aggregation>> = { count: 'count', count_if: 'count', sum: 'sum', sum_if: 'sum', average: 'average', min: 'min', max: 'max' }

/** an inline (unsaved) aggregate calculation built from the widget's source: "sum of Amount where Status is Paid" */
export function inlineCalculation(title: string, s: WidgetSource): CalculationBody {
  const agg = s.aggregation ?? (s.field ? 'sum' : 'count')
  return {
    type: 'calculation',
    name: title || 'Calculation',
    entity: s.entity ?? '',
    scope: 'aggregate',
    operation: OP_FOR[agg],
    ...(s.field && agg !== 'count' ? { inputs: [{ field: s.field }] } : {}),
    ...(s.filters?.length ? { filters: s.filters } : {}),
    ...(s.groupBy ? { groupBy: s.groupBy } : {}),
    ...(s.dateRange ? { dateRange: s.dateRange } : {}),
  }
}

/** the other direction: show an inline calculation in the same controls */
export function sourceFromCalculation(c: CalculationBody): WidgetSource {
  const first = c.inputs?.[0]
  return { entity: c.entity, aggregation: AGG_FOR[c.operation] ?? 'sum', ...(first && 'field' in first ? { field: first.field } : {}), ...(c.filters?.length ? { filters: c.filters } : {}), ...(c.groupBy ? { groupBy: c.groupBy } : {}), ...(c.dateRange ? { dateRange: c.dateRange } : {}) }
}

/** The widget to validate and save: for an inline calculation the source controls become the calculation body. */
export function finalizeWidget(w: DashboardWidgetShape, calc: { mode: 'saved' | 'inline'; ref?: string }): DashboardWidgetShape {
  if (w.type !== 'calculation') {
    const { calculation: _c, ...rest } = w
    return rest
  }
  const { source, calculation: _c, ...rest } = w
  if (calc.mode === 'saved') return { ...rest, ...(calc.ref ? { calculation: calc.ref } : {}) }
  return { ...rest, calculation: inlineCalculation(w.title, source ?? {}) }
}

export const isNumericFieldType = (t: string): boolean => ['number', 'currency', 'percentage', 'rating'].includes(t)
