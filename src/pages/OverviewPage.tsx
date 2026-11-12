import { formatDistanceToNow } from 'date-fns'
import { useActivities, useAllModules, useCtx, useCurrentUser, useModules, useRecords, useWorkflows, useWorkspace, useWsId } from '#/hooks/useData'
import { useSettingsStore } from '#/stores/settingsStore'
import { useUiStore } from '#/stores/uiStore'
import { Page } from '#/components/layout/Page'
import { AppLink, useGo } from '#/components/layout/AppLink'
import { Button } from '#/components/ui/Button'
import { Card } from '#/components/ui/misc'
import { Icon } from '#/components/ui/Icon'
import { OverviewDashboard } from '#/components/dashboard/OverviewDashboard'
export function OverviewPage() {
  const ws = useWorkspace()
  const wsId = useWsId()
  const user = useCurrentUser()
  const modules = useModules()
  const allModules = useAllModules()
  const records = useRecords()
  const workflows = useWorkflows()
  const acts = useActivities()
  const ctx = useCtx()
  const go = useGo()
  const showRecord = useUiStore((s) => s.showRecord)
  const startNew = useUiStore((s) => s.startNewRecord)
  const favs = useSettingsStore((s) => s.settings.favourites[wsId]) ?? []
  const recents = useSettingsStore((s) => s.settings.recents[wsId]) ?? []
  const tasksModule = allModules.find((m) => m.system === 'tasks')
  const openTasks = tasksModule ? records.filter((r) => r.moduleId === tasksModule.id && r.data.status !== 'done').length : 0
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'

  const stats = [
    { label: 'Modules', value: modules.length, icon: 'Boxes', to: '/modules', color: '#9aa0a6' },
    { label: 'Records', value: records.filter((r) => !tasksModule || r.moduleId !== tasksModule.id).length, icon: 'Database', to: '/modules', color: '#9aa0a6' },
    { label: 'Open tasks', value: openTasks, icon: 'CheckSquare', to: '/tasks', color: '#34a853' },
    { label: 'Active workflows', value: workflows.filter((w) => w.enabled).length, icon: 'Workflow', to: '/workflows', color: '#9aa0a6' },
  ]

  return (
    <Page title="Overview">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="section-label">{ws?.name}</p>
          <h1 className="mt-1 text-xl font-medium tracking-tight">{greeting}, {user?.name ?? 'there'}</h1>
          <p className="mt-1 text-[13px] text-muted">Everything here is stored privately in this browser.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button icon="Box" onClick={() => go('/module-builder')}>New module</Button>
          <Button icon="LayoutTemplate" onClick={() => go('/templates')}>Templates</Button>
        </div>
      </div>

      {modules.length > 0 && <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label} onClick={() => go(s.to)} className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-muted">{s.label}</span>
              <span className="flex size-8 items-center justify-center rounded-lg" style={{ background: `color-mix(in srgb, ${s.color} 15%, transparent)`, color: s.color }}><Icon name={s.icon} size={16} /></span>
            </div>
            <div className="mt-2 text-2xl font-semibold tabular-nums">{s.value}</div>
          </Card>
        ))}
      </div>}

      {modules.length === 0 && (
        <div className="mb-6 flex flex-col items-center rounded-xl border border-line bg-surface px-6 py-14 text-center">
          <span className="flex size-10 items-center justify-center rounded-lg border border-line text-muted"><Icon name="Sparkles" size={18} /></span>
          <h2 className="mt-4 text-[15px] font-medium">Describe your CRM</h2>
          <p className="mt-1 max-w-sm text-[13px] text-muted">Nothing is here yet. Tell Studio what your business tracks and it designs the modules, fields and dashboard for you.</p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <Button variant="primary" icon="Sparkles" onClick={() => go('/genius')}>Open Studio</Button>
            <Button icon="LayoutTemplate" onClick={() => go('/templates')}>Start from a template</Button>
          </div>
        </div>
      )}

      <OverviewDashboard />

      {modules.length > 0 && (
        <div className="mb-6">
          <h2 className="mb-3 text-sm font-semibold">Quick add</h2>
          <div className="flex flex-wrap gap-2">
            {modules.slice(0, 10).map((m) => (
              <button key={m.id} type="button" onClick={() => startNew(m.id)} className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-[13px] font-medium transition hover:border-line-strong hover:bg-subtle">
                <Icon name={m.icon} size={14} className="text-muted" /> New {m.name.replace(/s$/, '').toLowerCase()}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold">Recent items</h2><AppLink to="/recent" className="text-xs text-link hover:underline">View all</AppLink></div>
          {recents.length === 0 ? <p className="py-6 text-center text-[13px] text-muted">Records you open will show up here.</p> : (
            <ul className="space-y-1">
              {recents.slice(0, 6).map((r) => (
                <li key={`${r.moduleId}${r.recordId}`}>
                  <button type="button" onClick={() => (r.recordId ? showRecord(r.moduleId, r.recordId) : go(`/m/${r.moduleId}`))} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-subtle">
                    <Icon name={ctx.modules.get(r.moduleId)?.icon} size={14} className="text-muted" />
                    <span className="flex-1 truncate">{r.label}</span>
                    <span className="text-[11px] text-muted">{formatDistanceToNow(new Date(r.at), { addSuffix: true })}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold">Favourites</h2><AppLink to="/favourites" className="text-xs text-link hover:underline">View all</AppLink></div>
          {favs.length === 0 ? <p className="py-6 text-center text-[13px] text-muted">Star a record or module to pin it here.</p> : (
            <ul className="space-y-1">
              {favs.slice(0, 6).map((f, i) => (
                <li key={i}>
                  <button type="button" onClick={() => (f.recordId && f.moduleId ? showRecord(f.moduleId, f.recordId) : go(`/m/${f.moduleId}`))} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-subtle">
                    <Icon name="Star" size={14} className="text-warning" /><span className="truncate">{f.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold">Recent activity</h2><AppLink to="/recent" className="text-xs text-link hover:underline">View all</AppLink></div>
          {acts.length === 0 ? <p className="py-6 text-center text-[13px] text-muted">Activity appears as you work.</p> : (
            <ul className="space-y-2.5">
              {acts.slice(0, 6).map((a) => (
                <li key={a.id} className="text-[13px]">
                  <div className="line-clamp-2">{a.description}</div>
                  <div className="text-[11px] text-muted">{formatDistanceToNow(new Date(a.timestamp), { addSuffix: true })}</div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </Page>
  )
}
