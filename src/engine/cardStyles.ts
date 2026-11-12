import type { Field, Module } from '#/types'
import { isChoiceField } from './defaultDashboard'
import type { DashboardWidgetShape, DateRangeSpec, WidgetKind, WidgetVariant } from './schema'

/**
 * How a dashboard card can be shown. A card keeps its data source (module, field, filters, date range) whatever it looks
 * like: changing the display only changes the widget type, the variant and the accent colour. These are pure functions;
 * the side panel and the AI both call them and the result is saved through the dashboard service (validated again).
 */

export type DisplayId = 'kpi' | 'line' | 'bar' | 'donut' | 'progress' | 'bubbles'

export interface DisplayDef {
  id: DisplayId
  label: string
  hint: string
  /** widget types that already are this display */
  kinds: WidgetKind[]
  variants: { id: WidgetVariant; label: string }[]
}

export const DISPLAYS: DisplayDef[] = [
  { id: 'kpi', label: 'Number card', hint: 'One big number', kinds: ['kpi', 'revenue', 'record_count', 'average', 'conditional_stat', 'percentage'], variants: [{ id: 'minimal', label: 'Minimal' }, { id: 'icon', label: 'Icon style' }, { id: 'trend', label: 'Trend style' }] },
  { id: 'line', label: 'Line chart', hint: 'A value over time', kinds: ['line_chart'], variants: [{ id: 'smooth', label: 'Smooth' }, { id: 'step', label: 'Steps' }, { id: 'area', label: 'Area' }] },
  { id: 'bar', label: 'Bar chart', hint: 'Compare groups', kinds: ['bar_chart'], variants: [{ id: 'vertical', label: 'Vertical' }, { id: 'horizontal', label: 'Horizontal' }, { id: 'rounded', label: 'Rounded' }] },
  { id: 'donut', label: 'Donut chart', hint: 'Share of each group', kinds: ['doughnut_chart', 'pie_chart'], variants: [{ id: 'ring', label: 'Ring' }, { id: 'thin', label: 'Thin ring' }, { id: 'pie', label: 'Solid' }] },
  { id: 'progress', label: 'Progress', hint: 'A total against a target', kinds: ['progress'], variants: [{ id: 'bar', label: 'Horizontal bar' }, { id: 'circular', label: 'Circular' }, { id: 'segmented', label: 'Segmented' }] },
  { id: 'bubbles', label: 'Bubbles', hint: 'Groups as numbers', kinds: ['status_breakdown'], variants: [{ id: 'compact', label: 'Compact bubbles' }, { id: 'stacked', label: 'Stacked statistics' }, { id: 'colorcoded', label: 'Colour-coded' }] },
]

export const BUBBLE_VARIANTS: WidgetVariant[] = ['compact', 'stacked', 'colorcoded']

export const displayDef = (id: DisplayId): DisplayDef => DISPLAYS.find((d) => d.id === id)!
export const displayOf = (w: Pick<DashboardWidgetShape, 'type'>): DisplayDef | undefined => DISPLAYS.find((d) => d.kinds.includes(w.type))

export const CARD_COLORS: { id: string; label: string; hex: string }[] = [
  { id: 'blue', label: 'Blue', hex: '#4c8dff' },
  { id: 'pink', label: 'Pink', hex: '#ff4fa3' },
  { id: 'orange', label: 'Orange', hex: '#ff8a1f' },
  { id: 'green', label: 'Green', hex: '#34c26b' },
  { id: 'purple', label: 'Purple', hex: '#a17bff' },
  { id: 'teal', label: 'Teal', hex: '#2dd4bf' },
  { id: 'red', label: 'Red', hex: '#ef5350' },
  { id: 'yellow', label: 'Yellow', hex: '#f5c542' },
  { id: 'gray', label: 'Grey', hex: '#9aa0a6' },
]
export const colorByName = (name: string): string | undefined => CARD_COLORS.find((c) => c.id === name.toLowerCase())?.hex

const GROUP_BLOCK = new Set(['longText', 'password', 'file', 'image', 'document', 'signature'])
const moduleOf = (w: DashboardWidgetShape, modules: Module[]): Module | undefined => modules.find((m) => m.id === w.source?.entity || m.name === w.source?.entity)
const isDateType = (f: Field) => f.type === 'date' || f.type === 'datetime'

/** Is this card's data about time (so a line chart makes sense)? A line only appears in the list when it is. */
export function isTimeBased(w: DashboardWidgetShape, modules: Module[]): boolean {
  if (w.type === 'line_chart') return true
  const s = w.source
  if (!s) return false
  const m = moduleOf(w, modules)
  const range = typeof s.dateRange === 'object' ? s.dateRange : undefined
  if (s.dateField || range?.field || range?.bucket) return true
  if (s.groupBy === '__createdAt' || s.groupBy === '__updatedAt') return true
  const group = m?.fields.find((f) => f.id === s.groupBy)
  if (group && isDateType(group)) return true
  // a module that records dates can be shown over time
  return !!m?.fields.some(isDateType)
}

/** the displays this card can be switched to (line only for time-based data; charts only when something can be grouped) */
export function offeredDisplays(w: DashboardWidgetShape, modules: Module[]): DisplayDef[] {
  const here = displayOf(w)
  const m = moduleOf(w, modules)
  const hasSource = !!w.source?.entity
  if (!hasSource) return here ? [here] : []
  const groupable = !!pickGroupField(w, m)
  return DISPLAYS.filter((d) => {
    if (d.id === here?.id) return true
    if (d.id === 'line') return isTimeBased(w, modules)
    if (d.id === 'bar' || d.id === 'donut' || d.id === 'bubbles') return groupable
    return true
  })
}

function pickGroupField(w: DashboardWidgetShape, m: Module | undefined): string | undefined {
  const cur = w.source?.groupBy
  if (cur && cur !== '__createdAt' && cur !== '__updatedAt' && m?.fields.some((f) => f.id === cur && !isDateType(f))) return cur
  return m?.fields.find(isChoiceField)?.id ?? m?.fields.find((f) => !GROUP_BLOCK.has(f.type) && !isDateType(f) && f.type !== 'number' && f.type !== 'currency')?.id
}

export type ConvertResult = { ok: true; widget: DashboardWidgetShape } | { ok: false; reason: string }

/**
 * Switch a card to another display, keeping its data source. Returns the new widget or the plain reason it cannot be shown
 * that way (for example a bar chart needs something to group by). The caller still validates and saves it.
 */
export function convertDisplay(w: DashboardWidgetShape, display: DisplayId, modules: Module[]): ConvertResult {
  const def = displayDef(display)
  if (def.kinds.includes(w.type)) return { ok: true, widget: w }
  if (!w.source?.entity) return { ok: false, reason: 'This card has no data source yet. Choose one first.' }
  const m = moduleOf(w, modules)
  const keepStyleColor = w.style?.color ? { color: w.style.color } : {}
  const base: DashboardWidgetShape = { ...w, style: Object.keys(keepStyleColor).length ? keepStyleColor : undefined }
  if (!base.style) delete base.style
  const src = { ...w.source }
  const { groupBy: _group, dateRange, ...ungrouped } = src
  const range = stripBucket(dateRange)
  const flat = { ...ungrouped, ...(range ? { dateRange: range } : {}) }
  switch (display) {
    case 'kpi':
      return { ok: true, widget: { ...base, type: flat.field ? 'kpi' : 'record_count', source: flat.field ? flat : { ...flat, aggregation: 'count' }, target: undefined } }
    case 'progress':
      return { ok: true, widget: { ...base, type: 'progress', source: flat, target: w.target ?? 100 } }
    case 'line': {
      if (!isTimeBased(w, modules)) return { ok: false, reason: 'A line chart needs time-based data, and this card has no dates.' }
      const date = m?.fields.find(isDateType)
      const cur = typeof dateRange === 'object' ? dateRange : { preset: dateRange ?? ('all' as const) }
      return { ok: true, widget: { ...base, type: 'line_chart', source: { ...ungrouped, groupBy: date?.id ?? '__createdAt', aggregation: src.aggregation ?? (src.field ? 'sum' : 'count'), dateRange: { ...cur, bucket: cur.bucket ?? 'month' } } } }
    }
    case 'bar':
    case 'donut':
    case 'bubbles': {
      const group = pickGroupField(w, m)
      if (!group) return { ok: false, reason: 'There is no category field to group this data by, so this chart cannot be shown.' }
      const type: WidgetKind = display === 'bar' ? 'bar_chart' : display === 'donut' ? 'doughnut_chart' : 'status_breakdown'
      const aggregation = type === 'status_breakdown' ? undefined : (src.aggregation ?? (src.field ? 'sum' : 'count'))
      return { ok: true, widget: { ...base, type, source: { ...flat, groupBy: group, ...(aggregation ? { aggregation } : {}) } } }
    }
  }
}

/** a date range without the per-point bucket (only line charts use that) */
function stripBucket(r: DateRangeSpec | undefined): DateRangeSpec | undefined {
  if (!r || typeof r === 'string') return r
  const { bucket: _b, ...rest } = r
  return Object.keys(rest).length === 1 ? rest.preset : rest
}

/** the first variant of a display (what a card gets when its display changes) */
export const defaultVariant = (display: DisplayId): WidgetVariant => displayDef(display).variants[0].id

export function withVariant(w: DashboardWidgetShape, variant: WidgetVariant | undefined): DashboardWidgetShape {
  const style = { ...(w.style ?? {}), variant }
  if (!style.variant) delete style.variant
  return { ...w, style: Object.keys(style).length ? style : undefined }
}

export function withColor(w: DashboardWidgetShape, color: string | undefined): DashboardWidgetShape {
  const style = { ...(w.style ?? {}), color }
  if (!style.color) delete style.color
  return { ...w, style: Object.keys(style).length ? style : undefined }
}

/** a variant that belongs to the card's own display (a stale one from another display is ignored) */
export function variantOf(w: DashboardWidgetShape): WidgetVariant | undefined {
  const d = displayOf(w)
  const v = w.style?.variant
  return d && v && d.variants.some((x) => x.id === v) ? v : d?.variants[0].id
}
