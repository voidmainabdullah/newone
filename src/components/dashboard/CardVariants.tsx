import { useMemo } from 'react'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts'
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'
import { formatValue } from '#/engine/calc'
import { WIDGET_LABELS, type WidgetData } from '#/engine/widgets'
import type { DashboardWidgetShape, WidgetVariant } from '#/engine/schema'
import { variantOf } from '#/engine/cardStyles'
import { OPTION_COLORS } from '#/utils/fieldTypes'
import { Icon } from '#/components/ui/Icon'
import { useWidgetData } from './EngineWidget'
import { Empty } from './WidgetView'

type Format = Extract<WidgetData, { kind: 'value' }>['format']
type Points = Extract<WidgetData, { kind: 'series' }>['points']

const FALLBACK = '#4c8dff'
export const accentOf = (w: DashboardWidgetShape): string => w.style?.color ?? FALLBACK
const palette = (i: number, c?: string) => c ?? OPTION_COLORS[i % OPTION_COLORS.length]
/** one accent colour fans out into a few tints when a chart needs several slices */
const tint = (accent: string, i: number, n: number) => `color-mix(in srgb, ${accent} ${Math.round(100 - (i / Math.max(1, n)) * 55)}%, #1b1c1a)`

// ---- number cards ------------------------------------------------------------------------------------------------

export function KpiCard({ widget, ws, data }: { widget: DashboardWidgetShape; ws: string; data: Extract<WidgetData, { kind: 'value' }> }) {
  const v = variantOf(widget) ?? 'minimal'
  const accent = accentOf(widget)
  const text = formatValue(data.value, data.format)
  const caption = data.value === null ? 'No matching records yet' : data.caption
  if (v === 'icon') {
    return (
      <div className="flex h-full items-center gap-3">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-xl" style={{ background: `color-mix(in srgb, ${accent} 18%, transparent)`, color: accent }}><Icon name={WIDGET_LABELS[widget.type].icon} size={22} /></span>
        <div className="min-w-0">
          <div className="truncate text-2xl font-semibold tracking-tight tabular-nums">{text}</div>
          {caption && <div className="truncate text-xs text-muted">{caption}</div>}
        </div>
      </div>
    )
  }
  if (v === 'trend') return <TrendKpi widget={widget} ws={ws} text={text} caption={caption} accent={accent} format={data.format} />
  return (
    <div className="flex h-full flex-col justify-center">
      <div className="truncate text-3xl font-semibold tracking-tight tabular-nums" style={widget.style?.color ? { color: accent } : undefined}>{text}</div>
      {caption && <div className="mt-1 truncate text-xs text-muted">{caption}</div>}
    </div>
  )
}

/** the number, and how this month compares with last month (computed from the same source with a date window) */
function TrendKpi({ widget, ws, text, caption, accent, format }: { widget: DashboardWidgetShape; ws: string; text: string; caption?: string; accent: string; format: Format }) {
  const mk = (preset: 'this_month' | 'last_month'): DashboardWidgetShape => ({ ...widget, source: { ...widget.source, dateRange: { preset, ...(typeof widget.source?.dateRange === 'object' && widget.source.dateRange.field ? { field: widget.source.dateRange.field } : {}) } } })
  const thisW = useMemo(() => mk('this_month'), [widget]) // eslint-disable-line react-hooks/exhaustive-deps
  const lastW = useMemo(() => mk('last_month'), [widget]) // eslint-disable-line react-hooks/exhaustive-deps
  const a = useWidgetData(thisW, ws)
  const b = useWidgetData(lastW, ws)
  const cur = a?.kind === 'value' ? a.value : null
  const prev = b?.kind === 'value' ? b.value : null
  const delta = cur !== null && prev !== null && prev !== 0 ? Math.round(((cur - prev) / Math.abs(prev)) * 100) : null
  const up = (delta ?? 0) > 0
  const flat = delta === 0
  const Arrow = flat ? Minus : up ? ArrowUpRight : ArrowDownRight
  return (
    <div className="flex h-full flex-col justify-center gap-1">
      <div className="truncate text-3xl font-semibold tracking-tight tabular-nums">{text}</div>
      <div className="flex items-center gap-2 text-xs">
        {delta === null ? (
          <span className="text-muted">{cur !== null ? `This month ${formatValue(cur, format)}` : (caption ?? '')}</span>
        ) : (
          <>
            <span className={`flex items-center gap-0.5 rounded-full px-1.5 py-0.5 font-medium ${flat ? 'bg-subtle text-muted' : up ? 'bg-success/15 text-success' : 'bg-danger/15 text-danger'}`}><Arrow size={12} />{Math.abs(delta)}%</span>
            <span className="text-muted">vs last month</span>
          </>
        )}
      </div>
      <svg viewBox="0 0 100 6" className="mt-1 h-1.5 w-full" preserveAspectRatio="none" aria-hidden><rect width="100" height="6" rx="3" fill="var(--subtle)" /><rect width={Math.min(100, Math.max(6, delta === null ? 40 : 50 + delta / 2))} height="6" rx="3" fill={accent} /></svg>
    </div>
  )
}

// ---- progress ----------------------------------------------------------------------------------------------------

export function ProgressCard({ widget, data }: { widget: DashboardWidgetShape; data: Extract<WidgetData, { kind: 'progress' }> }) {
  const v = variantOf(widget) ?? 'bar'
  const accent = accentOf(widget)
  const nums = (
    <div className="flex items-baseline justify-between gap-2"><span className="text-2xl font-semibold tabular-nums">{formatValue(data.value, data.format)}</span><span className="text-xs text-muted">of {formatValue(data.target, data.format)}</span></div>
  )
  if (v === 'circular') {
    const r = 38
    const c = 2 * Math.PI * r
    return (
      <div className="flex h-full items-center gap-4">
        <div className="relative size-24 shrink-0" role="progressbar" aria-valuenow={data.pct} aria-valuemin={0} aria-valuemax={100}>
          <svg viewBox="0 0 100 100" className="size-full -rotate-90"><circle cx="50" cy="50" r={r} fill="none" stroke="var(--subtle)" strokeWidth="10" /><circle cx="50" cy="50" r={r} fill="none" stroke={accent} strokeWidth="10" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - Math.min(100, data.pct) / 100)} style={{ transition: 'stroke-dashoffset 0.5s ease' }} /></svg>
          <div className="absolute inset-0 flex items-center justify-center text-lg font-semibold tabular-nums">{data.pct}%</div>
        </div>
        <div className="min-w-0"><div className="truncate text-2xl font-semibold tabular-nums">{formatValue(data.value, data.format)}</div><div className="text-xs text-muted">of {formatValue(data.target, data.format)}</div></div>
      </div>
    )
  }
  if (v === 'segmented') {
    const on = Math.round(Math.min(100, data.pct) / 10)
    return (
      <div className="flex h-full flex-col justify-center gap-2.5">
        {nums}
        <div className="flex gap-1" role="progressbar" aria-valuenow={data.pct} aria-valuemin={0} aria-valuemax={100}>
          {Array.from({ length: 10 }).map((_, i) => <span key={i} className="h-3 flex-1 rounded-[3px] transition-colors duration-300" style={{ background: i < on ? accent : 'var(--subtle)' }} />)}
        </div>
        <div className="text-xs text-muted">{data.pct}% of target</div>
      </div>
    )
  }
  return (
    <div className="flex h-full flex-col justify-center gap-2">
      {nums}
      <div className="h-2.5 overflow-hidden rounded-full bg-subtle" role="progressbar" aria-valuenow={data.pct} aria-valuemin={0} aria-valuemax={100}><div className="h-full rounded-full transition-all duration-500" style={{ width: `${data.pct}%`, background: accent }} /></div>
      <div className="text-xs text-muted">{data.pct}% of target</div>
    </div>
  )
}

// ---- bubbles -----------------------------------------------------------------------------------------------------

export function BubblesCard({ widget, points, fmt }: { widget: DashboardWidgetShape; points: Points; fmt: (n: number) => string }) {
  const v = variantOf(widget) ?? 'compact'
  const accent = widget.style?.color
  const colorOf = (i: number, c?: string) => (accent ? tint(accent, i, points.length) : palette(i, c))
  const total = points.reduce((s, p) => s + p.value, 0) || 1
  if (v === 'stacked') {
    return (
      <div className="scroll-thin flex h-full flex-col gap-3 overflow-y-auto pr-1">
        <div className="flex h-3 shrink-0 overflow-hidden rounded-full bg-subtle">{points.map((p, i) => <span key={p.key} title={`${p.name}: ${fmt(p.value)}`} style={{ width: `${(p.value / total) * 100}%`, background: colorOf(i, p.color) }} />)}</div>
        <ul className="divide-y divide-line">
          {points.map((p, i) => (
            <li key={p.key} className="flex items-center gap-3 py-1.5">
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: colorOf(i, p.color) }} />
              <span className="min-w-0 flex-1 truncate text-[13px]">{p.name}</span>
              <span className="text-lg font-semibold tabular-nums">{fmt(p.value)}</span>
            </li>
          ))}
        </ul>
      </div>
    )
  }
  if (v === 'colorcoded') {
    const max = Math.max(1, ...points.map((p) => p.value))
    return (
      <div className="scroll-thin flex h-full flex-wrap content-center items-center justify-center gap-3 overflow-y-auto">
        {points.map((p, i) => {
          const size = 44 + Math.round(Math.sqrt(p.value / max) * 44)
          return (
            <div key={p.key} className="flex flex-col items-center gap-1" title={p.name}>
              <span className="flex items-center justify-center rounded-full text-sm font-semibold text-white tabular-nums" style={{ width: size, height: size, background: `color-mix(in srgb, ${colorOf(i, p.color)} 82%, #000)` }}>{fmt(p.value)}</span>
              <span className="max-w-[84px] truncate text-[11px] text-muted">{p.name}</span>
            </div>
          )
        })}
      </div>
    )
  }
  return (
    <div className="scroll-thin flex h-full flex-wrap content-start gap-2 overflow-y-auto pr-1">
      {points.map((p, i) => (
        <span key={p.key} className="flex items-center gap-2 rounded-full bg-subtle py-1 pr-3 pl-1.5 text-[13px]">
          <span className="flex size-6 items-center justify-center rounded-full text-[11px] font-semibold text-white tabular-nums" style={{ background: colorOf(i, p.color) }}>{fmt(p.value)}</span>
          <span className="max-w-[120px] truncate">{p.name}</span>
        </span>
      ))}
    </div>
  )
}

// ---- charts ------------------------------------------------------------------------------------------------------

export function VariantChart({ widget, points, fmt }: { widget: DashboardWidgetShape; points: Points; fmt: (n: number) => string }) {
  const v: WidgetVariant = (widget.type === 'pie_chart' && !widget.style?.variant ? 'pie' : variantOf(widget)) ?? 'smooth'
  const accent = widget.style?.color
  const main = accent ?? 'var(--primary)'
  if (!points.length || points.every((p) => p.value === 0 && p.count === 0)) return <Empty text="No data for this chart yet." />
  const tick = { fontSize: 11, fill: 'var(--muted)' }
  const tip = { contentStyle: { background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, fontSize: 12 }, formatter: (x: unknown) => fmt(Number(x)) }
  const grid = <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
  const margin = { top: 8, right: 12, left: -8, bottom: 0 }
  const short = (s: string) => (s.length > 10 ? `${s.slice(0, 9)}…` : s)

  if (widget.type === 'line_chart') {
    if (v === 'area') {
      const id = `area-${widget.id}`
      return (
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={points} margin={margin}>
            <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={main} stopOpacity={0.45} /><stop offset="100%" stopColor={main} stopOpacity={0.02} /></linearGradient></defs>
            {grid}
            <XAxis dataKey="name" tick={tick} tickLine={false} axisLine={false} />
            <YAxis tick={tick} tickLine={false} axisLine={false} width={44} />
            <RTooltip {...tip} />
            <Area type="monotone" dataKey="value" stroke={main} strokeWidth={2.5} fill={`url(#${id})`} />
          </AreaChart>
        </ResponsiveContainer>
      )
    }
    return (
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={margin}>
          {grid}
          <XAxis dataKey="name" tick={tick} tickLine={false} axisLine={false} />
          <YAxis tick={tick} tickLine={false} axisLine={false} width={44} />
          <RTooltip {...tip} />
          <Line type={v === 'step' ? 'stepAfter' : 'monotone'} dataKey="value" stroke={main} strokeWidth={2.5} dot={v === 'step' ? false : { r: 3 }} />
        </LineChart>
      </ResponsiveContainer>
    )
  }

  if (widget.type === 'bar_chart') {
    const cells = points.map((p, i) => <Cell key={p.key} fill={accent ?? palette(i, p.color)} />)
    if (v === 'horizontal') {
      return (
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={points} layout="vertical" margin={{ top: 4, right: 16, left: 4, bottom: 0 }}>
            <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" tick={tick} tickLine={false} axisLine={false} allowDecimals={false} />
            <YAxis type="category" dataKey="name" tick={tick} tickLine={false} axisLine={false} width={72} tickFormatter={short} />
            <RTooltip {...tip} cursor={{ fill: 'var(--subtle)' }} />
            <Bar dataKey="value" radius={[0, 6, 6, 0]}>{cells}</Bar>
          </BarChart>
        </ResponsiveContainer>
      )
    }
    return (
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={points} margin={margin}>
          {grid}
          <XAxis dataKey="name" tick={tick} tickLine={false} axisLine={false} interval={0} height={36} tickFormatter={short} />
          <YAxis tick={tick} tickLine={false} axisLine={false} width={44} allowDecimals={false} />
          <RTooltip {...tip} cursor={{ fill: 'var(--subtle)' }} />
          <Bar dataKey="value" radius={v === 'rounded' ? [999, 999, 0, 0] : [6, 6, 0, 0]} maxBarSize={v === 'rounded' ? 22 : 48}>{cells}</Bar>
        </BarChart>
      </ResponsiveContainer>
    )
  }

  // donut / pie
  const inner = v === 'pie' ? 0 : v === 'thin' ? '72%' : '50%'
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie data={points} dataKey="value" nameKey="name" innerRadius={inner} outerRadius="82%" paddingAngle={v === 'pie' ? 0 : 2} stroke="none">
          {points.map((p, i) => <Cell key={p.key} fill={accent ? tint(accent, i, points.length) : palette(i, p.color)} />)}
        </Pie>
        <RTooltip {...tip} />
      </PieChart>
    </ResponsiveContainer>
  )
}
