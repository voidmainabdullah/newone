import { memo, useEffect, useMemo, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { AlertTriangle } from 'lucide-react'
import { useActivities, useAllModules, useCtx, usePerms, useRecords } from '#/hooks/useData'
import { useEngineStore } from '#/stores/engineStore'
import { useUiStore } from '#/stores/uiStore'
import { formatValue } from '#/engine/calc'
import { makeEnv } from '#/engine/resolve'
import type { DashboardWidgetShape } from '#/engine/schema'
import { computeEngineWidget, type WidgetData } from '#/engine/widgets'
import { displayValue, recordTitle, valueOf } from '#/utils/records'
import { OPTION_COLORS } from '#/utils/fieldTypes'
import { Skeleton } from '#/components/ui/misc'
import { Empty } from './WidgetView'
import { BubblesCard, KpiCard, ProgressCard, VariantChart } from './CardVariants'
import { BUBBLE_VARIANTS } from '#/engine/cardStyles'

const palette = (i: number, c?: string) => c ?? OPTION_COLORS[i % OPTION_COLORS.length]

/** One snapshot of the project for every widget: rebuilt when modules or records change, and once a minute for "this month" style ranges. */
function useEngineEnv() {
  const modules = useAllModules()
  const records = useRecords()
  const ctx = useCtx()
  const [minute, setMinute] = useState(() => Math.floor(Date.now() / 60000))
  useEffect(() => {
    const t = setInterval(() => setMinute(Math.floor(Date.now() / 60000)), 60000)
    return () => clearInterval(t)
  }, [])
  return useMemo(() => makeEnv(modules, records, new Date(minute * 60000 + 1), ctx), [modules, records, ctx, minute])
}

/** the widget's data, memoised on the project snapshot and the widget config; null for the first paint (shows the skeleton) */
export function useWidgetData(widget: DashboardWidgetShape, ws: string): WidgetData | null {
  const env = useEngineEnv()
  const perms = usePerms()
  const docs = useEngineStore((s) => s.docs)
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])
  const calculations = useMemo(() => docs.find((d) => d.id === ws)?.calculations ?? [], [docs, ws])
  return useMemo(() => (ready ? computeEngineWidget(widget, env, { calculations, canView: (id) => perms.canModule(env.modules.find((m) => m.id === id), 'view') }) : null), [ready, widget, env, calculations, perms])
}

function Hint({ text, hint }: { text: string; hint?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center">
      <span className="text-[13px] text-muted">{text}</span>
      {hint && <span className="text-[11px] text-muted-2">{hint}</span>}
    </div>
  )
}

function Body({ widget, data, editing, ws }: { widget: DashboardWidgetShape; data: WidgetData; editing?: boolean; ws: string }) {
  const showRecord = useUiStore((s) => s.showRecord)
  const activities = useActivities()
  const ctx = useCtx()
  switch (data.kind) {
    case 'error':
      return (
        <div role="alert" className="flex h-full flex-col items-center justify-center gap-1.5 px-4 text-center">
          <AlertTriangle size={18} className="text-danger" />
          <span className="text-[13px] font-medium text-danger">This widget cannot be shown</span>
          <span className="line-clamp-3 text-xs text-muted">{data.message}</span>
          <span className="text-[11px] text-muted-2">{editing ? 'Open its settings to fix it.' : 'An editor can fix it in the dashboard settings.'}</span>
        </div>
      )
    case 'empty':
      return <Hint text={data.hint} hint={editing ? 'Use the settings button to configure it.' : undefined} />
    case 'value':
      return <KpiCard widget={widget} ws={ws} data={data} />
    case 'percentage':
      return data.value === null ? <Hint text="No records yet" hint="The share appears once there are records." /> : (
        <div className="flex h-full flex-col justify-center gap-2">
          <div className="text-3xl font-semibold tracking-tight tabular-nums">{data.value}%</div>
          <div className="h-2 overflow-hidden rounded-full bg-subtle" role="progressbar" aria-valuenow={data.value} aria-valuemin={0} aria-valuemax={100}><div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, data.value)}%` }} /></div>
          <div className="text-xs text-muted">{data.matched} of {data.total} records</div>
        </div>
      )
    case 'progress':
      return <ProgressCard widget={widget} data={data} />
    case 'profit':
      return (
        <div className="flex h-full flex-col justify-center gap-1.5">
          <div className={`text-3xl font-semibold tracking-tight tabular-nums ${data.profit < 0 ? 'text-danger' : 'text-success'}`}>{formatValue(data.profit, data.format)}</div>
          <div className="text-xs text-muted">{data.profit < 0 ? 'Loss' : 'Profit'}</div>
          <div className="flex gap-4 text-xs"><span>Income <b className="tabular-nums">{formatValue(data.income, data.format)}</b></span><span>Expenses <b className="tabular-nums">{formatValue(data.expense, data.format)}</b></span></div>
        </div>
      )
    case 'series': {
      if (!data.points.length) return <Hint text="No data yet" hint="This chart fills in as records are added." />
      const fmt = (n: number) => formatValue(n, data.format)
      if (widget.type === 'status_breakdown' && widget.style?.variant && BUBBLE_VARIANTS.includes(widget.style.variant)) return <BubblesCard widget={widget} points={data.points} fmt={fmt} />
      if (widget.type === 'status_breakdown') {
        const max = Math.max(1, ...data.points.map((p) => p.value))
        return (
          <div className="scroll-thin h-full space-y-2 overflow-y-auto pr-1">
            {data.points.map((p, i) => (
              <div key={p.key}>
                <div className="mb-0.5 flex justify-between text-xs"><span className="truncate font-medium">{p.name}</span><span className="text-muted tabular-nums">{formatValue(p.value, data.format)}</span></div>
                <div className="h-2.5 overflow-hidden rounded-full bg-subtle"><div className="h-full rounded-full" style={{ width: `${Math.max(3, (p.value / max) * 100)}%`, background: palette(i, p.color) }} /></div>
              </div>
            ))}
          </div>
        )
      }
      return <VariantChart widget={widget} points={data.points} fmt={fmt} />
    }
    case 'rows': {
      if (!data.records.length) return <Hint text="No records yet" hint={`New ${data.module.name} appear here.`} />
      if (widget.type === 'recent_records') {
        return (
          <ul className="scroll-thin h-full space-y-1 overflow-y-auto pr-1">
            {data.records.map((r) => <li key={r.id}><button type="button" onClick={() => showRecord(data.module.id, r.id)} className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-subtle"><span className="truncate font-medium">{recordTitle(data.module, r, ctx)}</span><span className="shrink-0 text-[11px] text-muted">{formatDistanceToNow(new Date(r.createdAt), { addSuffix: true })}</span></button></li>)}
          </ul>
        )
      }
      const cols = data.module.fields.filter((f) => !['password', 'longText', 'signature', 'file', 'image', 'document'].includes(f.type)).slice(0, 4)
      return (
        <div className="scroll-thin h-full overflow-auto">
          <table className="w-full text-[12px]">
            <thead className="sticky top-0 bg-surface text-left text-muted"><tr>{cols.map((c) => <th key={c.id} className="px-2 py-1.5 font-medium">{c.label}</th>)}</tr></thead>
            <tbody>{data.records.map((r) => <tr key={r.id} onClick={() => showRecord(data.module.id, r.id)} className="cursor-pointer border-t border-line hover:bg-subtle">{cols.map((c) => <td key={c.id} className="max-w-[140px] truncate px-2 py-1.5">{displayValue(c, valueOf(data.module, r, c, ctx), ctx) || '—'}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )
    }
    case 'activity': {
      const list = activities.slice(0, data.limit)
      if (!list.length) return <Empty text="No activity yet." />
      return (
        <ul className="scroll-thin h-full space-y-2.5 overflow-y-auto pr-1">
          {list.map((a) => <li key={a.id} className="flex gap-2 text-[13px]"><span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" /><div className="min-w-0"><div className="truncate">{a.description}</div><div className="text-[11px] text-muted">{formatDistanceToNow(new Date(a.timestamp), { addSuffix: true })}</div></div></li>)}
        </ul>
      )
    }
  }
}

/**
 * The ONE renderer for engine dashboard widgets (kpi, revenue, profit/loss, count, average, percentage, progress, line, bar,
 * pie, doughnut, table, recent activity, status breakdown, conditional statistic, custom calculation). The numbers come from
 * engine/widgets.ts -> engine/aggregate.ts, so they follow the records live. Skeleton while loading, a hint when there is no
 * data, a message when the configuration is broken.
 */
export const EngineWidgetView = memo(function EngineWidgetView({ widget, ws, editing }: { widget: DashboardWidgetShape; ws: string; editing?: boolean }) {
  const data = useWidgetData(widget, ws)
  if (!data) return <div className="space-y-2" aria-busy="true" aria-label="Loading"><Skeleton className="h-8 w-1/2" /><Skeleton className="h-3 w-3/4" /><Skeleton className="h-16 w-full" /></div>
  return <Body widget={widget} data={data} editing={editing} ws={ws} />
})
