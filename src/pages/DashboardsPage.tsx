import { useEffect, useMemo, useRef, useState } from 'react'
import { useAllModules, useCurrentUser, useDashboards, usePerms, useWsId } from '#/hooks/useData'
import { useDashboardStore } from '#/stores/collections'
import { useEngineStore } from '#/stores/engineStore'
import { useConfigNav } from '#/stores/configNavStore'
import { ensureDefaultDashboard } from '#/engine/defaultDashboard'
import { activeDashboard, isOwnedBy, visibleDashboards } from '#/engine/dashboards'
import { createUserDashboard, hasOwnCopy, restoreDefaultDashboard, saveDashboardLayout } from '#/engine/dashboardService'
import { sortedWidgets } from '#/engine/dashboardOps'
import { useSelectionStore } from '#/stores/selectionStore'
import { defaultWidget, WIDGET_TYPES } from '#/utils/metrics'
import { cn, nowIso, uid } from '#/utils/id'
import { confirmDialog, toast } from '#/utils/toast'
import type { Dashboard, Widget } from '#/types'
import { Page } from '#/components/layout/Page'
import { Button } from '#/components/ui/Button'
import { Modal } from '#/components/ui/Modal'
import { NameDialog } from '#/components/ui/Overlays'
import { EmptyState, PageHeader } from '#/components/ui/misc'
import { Icon } from '#/components/ui/Icon'
import { Menu } from '#/components/ui/Popover'
import { EngineDashboardView } from '#/components/dashboard/EngineDashboardView'
import { DashboardGrid } from '#/builders/DashboardBuilder/DashboardGrid'
import { WidgetConfigModal } from '#/builders/DashboardBuilder/WidgetConfigModal'
import { MoreHorizontal } from 'lucide-react'

/**
 * Dashboards. The engine dashboards (per project AND per user: your own layout, or a copy of the project's default) come
 * first; dashboards made with the earlier builder are still listed and keep working below them.
 */
export function DashboardsPage() {
  const ws = useWsId()
  const legacyAll = useDashboards()
  const modules = useAllModules().filter((m) => !m.archived)
  const perms = usePerms()
  const user = useCurrentUser()
  const userId = user?.id ?? ''
  const sel = useSelectionStore()
  const legacyStore = useDashboardStore.getState()
  const docs = useEngineStore((s) => s.docs)
  const [editing, setEditing] = useState(false)
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [picking, setPicking] = useState(false)
  const [configuring, setConfiguring] = useState<Widget | null>(null)
  const [legacyPicking, setLegacyPicking] = useState(false)
  const canManage = perms.can('manageDashboards')

  // a workspace that predates the engine (or was restored from a backup) gets its Overview config the first time this opens
  useEffect(() => { if (ws) ensureDefaultDashboard(ws) }, [ws])

  const all = useMemo(() => docs.find((d) => d.id === ws)?.dashboards ?? [], [docs, ws])
  const engineList = useMemo(() => visibleDashboards(all, userId), [all, userId])
  // the overview mirrored for the earlier builder is replaced by the engine one
  const legacyList = useMemo(() => legacyAll.filter((d) => d.id !== `dash_overview_${ws}`), [legacyAll, ws])
  const legacy = legacyList.find((d) => d.id === sel.dashboardId)
  const engine = legacy ? undefined : activeDashboard(all, userId, sel.dashboardId ?? undefined)
  const current = engine?.id ?? legacy?.id

  useEffect(() => { if (current && current !== sel.dashboardId) sel.set({ dashboardId: current }) }, [current]) // eslint-disable-line react-hooks/exhaustive-deps
  const keepEditing = useRef<string | null>(null)
  useEffect(() => {
    // switching dashboards leaves edit mode, except when Studio just sent the person here to edit this one
    const keep = keepEditing.current === current
    keepEditing.current = null
    if (!keep) setEditing(false)
  }, [current])
  // Studio's "Edit" on a drafted dashboard: it was saved as the person's own, so select it and go straight into the builder
  const navDash = useConfigNav((s) => s.dashboard)
  useEffect(() => {
    if (!navDash || navDash.workspaceId !== ws) return
    if (all.some((d) => d.id === navDash.dashboardId)) {
      keepEditing.current = navDash.dashboardId
      sel.set({ dashboardId: navDash.dashboardId })
      setEditing(true)
    }
    useConfigNav.getState().clear('dashboard')
  }, [navDash, ws, all]) // eslint-disable-line react-hooks/exhaustive-deps

  const own = engine ? hasOwnCopy(all, userId, engine) : false
  const personal = !!engine && isOwnedBy(engine, userId) && !engine.baseId

  const createEngine = (name: string) => {
    const r = createUserDashboard(ws, userId, name)
    if (!r.ok || !r.dashboard) return void toast.error('Could not create the dashboard', r.errors[0]?.message)
    sel.set({ dashboardId: r.dashboard.id })
    setEditing(true)
    toast.success('Dashboard created', 'Add your first widget.')
  }
  const duplicateEngine = () => {
    if (!engine) return
    const r = createUserDashboard(ws, userId, `${engine.name} (copy)`)
    if (!r.ok || !r.dashboard) return void toast.error('Could not duplicate', r.errors[0]?.message)
    const widgets = sortedWidgets(engine.widgets).map((w) => ({ ...structuredClone(w), id: uid('w') }))
    saveDashboardLayout(ws, userId, r.dashboard.id, { widgets })
    sel.set({ dashboardId: r.dashboard.id })
    toast.success('Dashboard duplicated')
  }
  const restore = async () => {
    if (!engine) return
    const ok = await confirmDialog({ title: personal ? `Delete “${engine.name}”?` : 'Restore the default dashboard?', message: personal ? 'This dashboard is only yours and cannot be recovered.' : 'Your own layout is removed and you see the project’s default again. Other people are not affected.', confirmLabel: personal ? 'Delete' : 'Restore default', danger: true })
    if (!ok) return
    const r = restoreDefaultDashboard(ws, userId, engine.id)
    if (!r.ok) return void toast.error('Not allowed', r.error)
    sel.set({ dashboardId: null })
    toast.success(personal ? 'Dashboard deleted' : 'Default dashboard restored')
  }

  const setLegacyWidgets = (widgets: Widget[]) => legacy && legacyStore.update(legacy.id, { widgets })
  const addLegacy = (type: Widget['type']) => {
    if (!legacy) return
    const tasks = modules.find((m) => m.system === 'tasks')
    const moduleId = type === 'tasks' ? tasks?.id : type === 'recentActivities' ? undefined : (modules.find((m) => !m.system) ?? modules[0])?.id
    const w = defaultWidget(type, moduleId, uid('w'))
    setLegacyWidgets([...legacy.widgets, w])
    setLegacyPicking(false)
    if (type !== 'recentActivities') setConfiguring(w)
  }
  const target = engine ?? legacy

  return (
    <Page title="Dashboards" wide skeleton="cards">
      <PageHeader title="Dashboards" icon="PieChart" description="Live widgets computed from your records. Everything updates the moment data changes."
        actions={canManage && <>
          {target && <Button icon={editing ? 'Check' : 'Pencil'} variant={editing ? 'primary' : 'secondary'} onClick={() => setEditing((e) => !e)}>{editing ? 'Done editing' : 'Edit dashboard'}</Button>}
          {target && editing && <Button icon="Plus" variant="primary" onClick={() => (engine ? setPicking(true) : setLegacyPicking(true))}>Add widget</Button>}
          <Button icon="Plus" onClick={() => setCreating(true)}>New dashboard</Button>
        </>} />
      {(engineList.length > 0 || legacyList.length > 0) && (
        <div className="mb-5 flex flex-wrap items-center gap-1.5">
          {engineList.map((d) => <button key={d.id} type="button" onClick={() => sel.set({ dashboardId: d.id })} className={cn('rounded-lg border px-3 py-1.5 text-[13px] font-medium transition', d.id === engine?.id ? 'border-primary bg-subtle text-link' : 'border-line hover:bg-subtle')}>{d.name}</button>)}
          {legacyList.map((d) => <button key={d.id} type="button" onClick={() => sel.set({ dashboardId: d.id })} className={cn('rounded-lg border px-3 py-1.5 text-[13px] font-medium transition', d.id === legacy?.id ? 'border-primary bg-subtle text-link' : 'border-line hover:bg-subtle')}>{d.name}</button>)}
          {engine && canManage && (
            <Menu items={[
              { label: 'Rename', icon: 'Pencil', disabled: !isOwnedBy(engine, userId) && engine.scope === 'user', onClick: () => setRenaming(true) },
              { label: 'Duplicate', icon: 'Copy', onClick: duplicateEngine },
              { divider: true },
              { label: personal ? 'Delete' : 'Restore default', icon: personal ? 'Trash2' : 'RotateCcw', danger: personal, disabled: !personal && !own, onClick: () => void restore() },
            ]} trigger={({ toggle, ref }) => <button ref={ref} type="button" aria-label="Dashboard options" onClick={toggle} className="rounded-lg p-1.5 text-muted hover:bg-subtle"><MoreHorizontal size={16} /></button>} />
          )}
          {legacy && canManage && (
            <Menu items={[
              { label: 'Rename', icon: 'Pencil', onClick: () => setRenaming(true) },
              { label: 'Duplicate', icon: 'Copy', onClick: () => { const t = nowIso(); const c: Dashboard = { ...structuredClone(legacy), id: uid('dash'), name: `${legacy.name} (copy)`, widgets: legacy.widgets.map((w) => ({ ...w, id: uid('w') })), createdAt: t, updatedAt: t }; legacyStore.add(c); sel.set({ dashboardId: c.id }); toast.success('Dashboard duplicated') } },
              { divider: true },
              { label: 'Delete', icon: 'Trash2', danger: true, onClick: async () => { if (await confirmDialog({ title: `Delete “${legacy.name}”?`, confirmLabel: 'Delete', danger: true })) { legacyStore.remove(legacy.id); sel.set({ dashboardId: null }) } } },
            ]} trigger={({ toggle, ref }) => <button ref={ref} type="button" aria-label="Dashboard options" onClick={toggle} className="rounded-lg p-1.5 text-muted hover:bg-subtle"><MoreHorizontal size={16} /></button>} />
          )}
        </div>
      )}
      {engine ? (
        <EngineDashboardView ws={ws} dashboard={engine} userId={userId} editing={editing} picking={picking} onPickClose={() => setPicking(false)} onEditRequest={() => { setEditing(true); setPicking(true) }} canManage={canManage} />
      ) : !legacy ? (
        <EmptyState icon="PieChart" title="No dashboards yet" description="Create a dashboard and add widgets that summarise your data." action={canManage && <Button variant="primary" icon="Plus" onClick={() => setCreating(true)}>New dashboard</Button>} />
      ) : legacy.widgets.length === 0 ? (
        <EmptyState icon="LayoutDashboard" title="This dashboard is empty" description={canManage ? 'Add widgets to start tracking your numbers.' : 'Ask an admin to add widgets.'} action={canManage && <Button variant="primary" icon="Plus" onClick={() => { setEditing(true); setLegacyPicking(true) }}>Add widget</Button>} />
      ) : (
        <DashboardGrid widgets={legacy.widgets} editing={editing && canManage} onChange={setLegacyWidgets} onConfigure={setConfiguring} />
      )}

      <Modal open={legacyPicking} onClose={() => setLegacyPicking(false)} size="lg" title="Add a widget" description="Pick what to visualise. You can tweak the source and calculation next.">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {WIDGET_TYPES.map((t) => (
            <button key={t.type} type="button" onClick={() => addLegacy(t.type)} className="rounded-xl border border-line p-3 text-left transition hover:border-primary hover:bg-subtle">
              <Icon name={t.icon} size={18} className="text-link" />
              <div className="mt-1.5 text-[13px] font-semibold">{t.label}</div>
              <div className="text-[11px] text-muted">{t.hint}</div>
            </button>
          ))}
        </div>
      </Modal>
      {configuring && <WidgetConfigModal widget={configuring} onClose={() => setConfiguring(null)} onSave={(w) => { legacy && setLegacyWidgets(legacy.widgets.map((x) => (x.id === w.id ? w : x))); setConfiguring(null) }} />}
      <NameDialog open={creating} title="New dashboard" label="Dashboard name" initial="New dashboard" confirmLabel="Create" onClose={() => setCreating(false)} onSubmit={createEngine} />
      {target && (
        <NameDialog open={renaming} title="Rename dashboard" label="Dashboard name" initial={target.name} onClose={() => setRenaming(false)} onSubmit={(n) => {
          if (legacy) return void legacyStore.update(legacy.id, { name: n })
          if (engine) { const r = saveDashboardLayout(ws, userId, engine.id, { name: n }); if (!r.ok) toast.error('Could not rename', r.errors[0]?.message) }
        }} />
      )}
    </Page>
  )
}
