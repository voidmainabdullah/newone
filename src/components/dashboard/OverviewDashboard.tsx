import { useEffect, useMemo } from 'react'
import { useCurrentUser, useWsId } from '#/hooks/useData'
import { useEngineStore } from '#/stores/engineStore'
import { ensureDefaultDashboard } from '#/engine/defaultDashboard'
import { activeDashboard } from '#/engine/dashboards'
import { AppLink } from '#/components/layout/AppLink'
import { EngineDashboardGrid } from './EngineDashboardGrid'
import { WorkspaceInsights } from './WorkspaceInsights'

/**
 * The project's "Overview" dashboard on the Overview page: the same engine dashboard (and the same per-user layout) the
 * Dashboards page edits, with live data from the first open. A project whose dashboard has no widgets yet (no modules) falls
 * back to the per-module analytics.
 */
export function OverviewDashboard() {
  const ws = useWsId()
  const user = useCurrentUser()
  const docs = useEngineStore((s) => s.docs)
  // a project created before the engine existed (or restored from a backup) gets its Overview here, the first time it is opened
  useEffect(() => { if (ws) ensureDefaultDashboard(ws) }, [ws])
  const dash = useMemo(() => activeDashboard(docs.find((d) => d.id === ws)?.dashboards ?? [], user?.id), [docs, ws, user?.id])
  const widgets = dash?.widgets.filter((w) => w.enabled !== false) ?? []
  if (!dash || widgets.length === 0) return <WorkspaceInsights />
  return (
    <section className="mb-6" aria-label={dash.name}>
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">{dash.name}</h2>
          <p className="text-xs text-muted">Live numbers from this project’s records.</p>
        </div>
        <AppLink to="/dashboards" className="text-xs text-link hover:underline">Open dashboard</AppLink>
      </div>
      <EngineDashboardGrid ws={ws} widgets={widgets} editing={false} onChange={() => undefined} onConfigure={() => undefined} />
    </section>
  )
}
