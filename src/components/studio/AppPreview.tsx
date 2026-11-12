import { useMemo, useState } from 'react'
import { Icon } from '#/components/ui/Icon'
import { cn } from '#/utils/id'
import { displayField, formatCell, groupCounts, rowsFor, widgetValue, type PApp, type PModule, type PWidget } from './previewModel'

export type Device = 'desktop' | 'tablet' | 'mobile'
export const OVERVIEW = '__overview'

const WIDGET_ICON: Record<string, string> = { stat: 'Hash', metric: 'Hash', bar: 'BarChart3', line: 'LineChart', pie: 'PieChart', table: 'Table', recentRecords: 'ListChecks', progress: 'Gauge', pipeline: 'KanbanSquare' }

/**
 * The generated CRM drawn as its own small app: a sidebar with only the modules that were designed, an Overview with KPI
 * cards and charts, and one page per module with a table (and a board when the module has a pipeline). All rows are
 * sample data derived from the design; it is a picture of the result, not a workspace.
 */
export function AppPreview({ app, page, onPage, device }: { app: PApp; page: string; onPage: (id: string) => void; device: Device }) {
  const groups = useMemo(() => {
    const g = new Map<string, PModule[]>()
    for (const m of app.modules) g.set(m.group, [...(g.get(m.group) ?? []), m])
    return [...g.entries()]
  }, [app])
  const mod = app.modules.find((m) => m.id === page)
  const compact = device !== 'desktop'
  const narrow = device === 'mobile'

  return (
    <div className={cn('flex h-full min-h-0 overflow-hidden bg-app text-fg', narrow && 'flex-col')} aria-label={`${app.name} preview`}>
      <nav aria-label="Preview navigation" className={cn('shrink-0 border-line bg-side', narrow ? 'flex gap-1 overflow-x-auto border-b p-2' : cn('overflow-y-auto border-r p-3', compact ? 'w-[52px] px-2' : 'w-[200px]'))}>
        {!narrow && (
          <div className={cn('mb-3 flex items-center gap-2 px-1', compact && 'justify-center')}>
            <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-[11px] font-medium text-white">{app.name.slice(0, 1).toUpperCase()}</span>
            {!compact && <span className="truncate text-[13px] font-medium">{app.name}</span>}
          </div>
        )}
        <NavBtn icon="LayoutDashboard" label="Overview" active={page === OVERVIEW} onClick={() => onPage(OVERVIEW)} compact={compact} pill={narrow} />
        {groups.map(([group, mods]) => (
          <div key={group} className={cn(narrow ? 'flex gap-1' : 'mt-3')}>
            {!compact && <div className="section-label px-2 pb-1">{group}</div>}
            {mods.map((m) => <NavBtn key={m.id} icon={m.icon} label={m.plural} active={page === m.id} onClick={() => onPage(m.id)} compact={compact} pill={narrow} />)}
          </div>
        ))}
      </nav>
      <div className="scroll-thin min-w-0 flex-1 overflow-y-auto">
        {page === OVERVIEW || !mod ? <Overview app={app} onPage={onPage} narrow={narrow} /> : <ModulePage key={mod.id} app={app} mod={mod} narrow={narrow} />}
      </div>
    </div>
  )
}

function NavBtn({ icon, label, active, onClick, compact, pill }: { icon: string; label: string; active: boolean; onClick: () => void; compact: boolean; pill: boolean }) {
  return (
    <button type="button" title={label} onClick={onClick} className={cn('flex shrink-0 items-center gap-2 rounded-lg text-left text-[13px] transition', pill ? 'px-2.5 py-1.5' : compact ? 'size-8 justify-center' : 'w-full px-2 py-1.5', active ? 'bg-subtle text-fg' : 'text-muted hover:bg-surface hover:text-fg')}>
      <Icon colorful name={icon} size={16} />
      {(!compact || pill) && <span className="truncate">{label}</span>}
    </button>
  )
}

function PageHead({ title, sub, action }: { title: string; sub?: string; action?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3.5">
      <div className="min-w-0">
        <h2 className="truncate text-[15px] font-medium">{title}</h2>
        {sub && <p className="text-xs text-muted">{sub}</p>}
      </div>
      <span className="ml-auto rounded-md border border-line px-2 py-0.5 text-[11px] text-muted">Sample data</span>
      {action && <span className="flex h-7 items-center gap-1.5 rounded-lg bg-primary px-2.5 text-xs font-medium text-white"><Icon colorful name="Plus" size={13} />{action}</span>}
    </div>
  )
}

function Overview({ app, onPage, narrow }: { app: PApp; onPage: (id: string) => void; narrow: boolean }) {
  const stats = app.widgets.filter((w) => w.type === 'stat' || w.type === 'metric' || w.type === 'progress')
  const charts = app.widgets.filter((w) => !['stat', 'metric', 'progress'].includes(w.type))
  const fallback: PWidget[] = app.modules.slice(0, 4).map((m) => ({ id: `c_${m.id}`, title: m.plural, type: 'stat', moduleId: m.id, agg: 'count', w: 1, definition: `Number of ${m.plural.toLowerCase()}` }))
  const cards = stats.length ? stats : fallback
  return (
    <div>
      <PageHead title={app.dashboardName} sub={app.name} />
      <div className="space-y-4 p-5">
        <div className={cn('stagger grid gap-3', narrow ? 'grid-cols-2' : 'grid-cols-2 lg:grid-cols-4')}>
          {cards.slice(0, 8).map((w) => (
            <div key={w.id} className="rounded-xl border border-line bg-surface p-3.5">
              <div className="flex items-center gap-1.5 text-xs text-muted"><Icon colorful name={WIDGET_ICON[w.type] ?? 'Hash'} size={13} /><span className="truncate">{w.title}</span></div>
              <div className="mt-2 text-2xl font-medium tabular-nums">{widgetValue(app, w)}</div>
              <p className="mt-1 line-clamp-1 text-[11px] text-muted-2">{w.definition}</p>
            </div>
          ))}
        </div>
        {charts.length > 0 && (
          <div className={cn('stagger grid gap-3', narrow ? 'grid-cols-1' : 'md:grid-cols-2')}>
            {charts.slice(0, 4).map((w) => <ChartCard key={w.id} app={app} w={w} />)}
          </div>
        )}
        <div>
          <div className="section-label mb-2">Modules</div>
          <div className={cn('stagger grid gap-2', narrow ? 'grid-cols-1' : 'grid-cols-2 lg:grid-cols-3')}>
            {app.modules.map((m) => (
              <button type="button" key={m.id} onClick={() => onPage(m.id)} className="flex items-center gap-3 rounded-xl border border-line bg-surface p-3 text-left transition hover:border-line-strong">
                <span className="flex size-8 items-center justify-center rounded-lg bg-subtle text-muted"><Icon colorful name={m.icon} size={16} /></span>
                <span className="min-w-0"><span className="block truncate text-[13px] font-medium">{m.plural}</span><span className="text-[11px] text-muted">{m.fields.length} fields</span></span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function ChartCard({ app, w }: { app: PApp; w: PWidget }) {
  const data = groupCounts(app, w)
  const max = Math.max(1, ...data.map((d) => d.n))
  const mod = app.modules.find((m) => m.id === w.moduleId)
  const rows = mod && (w.type === 'table' || w.type === 'recentRecords') ? rowsFor(app, mod, 4) : []
  const df = mod ? displayField(mod) : undefined
  return (
    <div className="rounded-xl border border-line bg-surface p-3.5">
      <div className="mb-3 flex items-center gap-1.5 text-xs text-muted"><Icon colorful name={WIDGET_ICON[w.type] ?? 'BarChart3'} size={13} /><span className="truncate">{w.title}</span></div>
      {rows.length > 0 && mod && df ? (
        <ul className="divide-y divide-line text-[13px]">{rows.map((r, i) => <li key={i} className="flex items-center justify-between gap-3 py-1.5"><span className="truncate">{formatCell(df, r[df.id])}</span><span className="truncate text-xs text-muted">{mod.fields[1] ? formatCell(mod.fields[1], r[mod.fields[1].id]) : ''}</span></li>)}</ul>
      ) : (
        <ul className="space-y-2">
          {data.slice(0, 6).map((d) => (
            <li key={d.label} className="text-xs">
              <div className="mb-1 flex justify-between text-muted"><span className="truncate">{d.label}</span><span className="tabular-nums">{d.n}</span></div>
              <div className="h-1.5 rounded-full bg-subtle"><div className="h-full rounded-full bg-primary" style={{ width: `${(d.n / max) * 100}%` }} /></div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ModulePage({ app, mod, narrow }: { app: PApp; mod: PModule; narrow: boolean }) {
  const [view, setView] = useState<'table' | 'board'>('table')
  const rows = useMemo(() => rowsFor(app, mod), [app, mod])
  const cols = mod.fields.slice(0, narrow ? 3 : 7)
  const df = displayField(mod)
  const stageField = mod.fields.find((f) => f.id === mod.stageFieldId)
  const board = !!(mod.stages?.length && stageField)
  return (
    <div>
      <PageHead title={mod.plural} sub={`${rows.length} records`} action={`New ${mod.singular.toLowerCase()}`} />
      <div className="space-y-3 p-5">
        {board && (
          <div className="inline-flex rounded-lg border border-line bg-surface p-0.5 text-xs">
            {(['table', 'board'] as const).map((v) => (
              <button key={v} type="button" onClick={() => setView(v)} className={cn('rounded-md px-2.5 py-1 capitalize transition', view === v ? 'bg-subtle text-fg' : 'text-muted hover:text-fg')}>{v}</button>
            ))}
          </div>
        )}
        {view === 'board' && board && stageField ? (
          <div className="scroll-thin flex gap-3 overflow-x-auto pb-2">
            {mod.stages!.map((s) => {
              const inStage = rows.filter((r) => String(r[stageField.id]) === s.label)
              return (
                <div key={s.id} className="w-56 shrink-0 rounded-xl border border-line bg-surface p-2">
                  <div className="mb-2 flex items-center justify-between px-1.5 text-xs text-muted"><span className="truncate">{s.label}</span><span className="tabular-nums">{inStage.length}</span></div>
                  <div className="space-y-2">
                    {inStage.map((r, i) => (
                      <div key={i} className="rounded-lg border border-line bg-app p-2.5 text-[13px]">
                        <div className="truncate font-medium">{df ? formatCell(df, r[df.id]) : '—'}</div>
                        {cols[1] && cols[1].id !== df?.id && <div className="mt-0.5 truncate text-xs text-muted">{formatCell(cols[1], r[cols[1].id])}</div>}
                      </div>
                    ))}
                    {inStage.length === 0 && <div className="px-1.5 py-3 text-center text-[11px] text-muted-2">No records</div>}
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="scroll-thin overflow-x-auto rounded-xl border border-line bg-surface">
            <table className="w-full min-w-max text-left text-[13px]">
              <thead>
                <tr className="border-b border-line">{cols.map((f) => <th key={f.id} className="section-label whitespace-nowrap px-3 py-2.5 font-medium">{f.label}</th>)}</tr>
              </thead>
              <tbody className="stagger">
                {rows.map((r, i) => (
                  <tr key={i} className="border-b border-line last:border-0 hover:bg-subtle/60">
                    {cols.map((f, ci) => <td key={f.id} className={cn('whitespace-nowrap px-3 py-2', ci === 0 ? 'font-medium' : 'text-muted')}>{formatCell(f, r[f.id])}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
