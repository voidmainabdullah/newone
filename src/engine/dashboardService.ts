import type { Role } from '#/types'
import { useEngineStore } from '#/stores/engineStore'
import { isOwnedBy } from './dashboards'
import { stripMeta, type Issue } from './items'
import type { DashboardBody, DashboardWidgetShape, EngineDashboard } from './schema'
import { currentRole, validationEnvFor } from './service'
import { validateConfig, ENGINE_PERMISSION } from './validate'

/**
 * Guarded dashboard saves. The dashboard page never writes the store directly: a layout is validated (every widget's module,
 * field and aggregation against the real schema, plus the person's `manageDashboards` permission) and then saved for the
 * USER (a shared dashboard is forked into their own copy, so other users keep theirs).
 */

export interface DashboardSave {
  ok: boolean
  errors: Issue[]
  dashboard?: EngineDashboard
}

/** Validate one widget the way a saved dashboard would. */
export function validateWidget(ws: string, widget: DashboardWidgetShape, role?: Role | null): Issue[] {
  const res = validateConfig({ type: 'dashboard_widget', name: widget.title || 'widget', widget }, validationEnvFor(ws, { role }))
  return res.errors
}

export function saveDashboardLayout(ws: string, userId: string, dashboardId: string, patch: Partial<DashboardBody>, role?: Role | null): DashboardSave {
  const store = useEngineStore.getState()
  const target = store.docOf(ws).dashboards.find((d) => d.id === dashboardId)
  if (!target) return { ok: false, errors: [{ path: '(root)', message: 'This dashboard no longer exists' }] }
  if (target.scope === 'user' && !isOwnedBy(target, userId)) return { ok: false, errors: [{ path: '(permission)', message: 'This dashboard belongs to another user' }] }
  const candidate = { ...(stripMeta(target) as unknown as DashboardBody), ...patch, scope: 'user' as const, userId }
  const res = validateConfig(candidate, validationEnvFor(ws, { role, existingId: target.id }), 'dashboards')
  if (!res.ok) return { ok: false, errors: res.errors }
  const saved = store.saveDashboardFor(ws, userId, dashboardId, patch)
  return saved ? { ok: true, errors: [], dashboard: saved } : { ok: false, errors: [{ path: '(root)', message: 'The dashboard could not be saved' }] }
}

/** A new personal dashboard (only its owner sees it). */
export function createUserDashboard(ws: string, userId: string, name: string, role?: Role | null): DashboardSave {
  const body: DashboardBody = { type: 'dashboard', name: name.trim() || 'New dashboard', scope: 'user', userId, widgets: [], enabled: true }
  const res = validateConfig(body, validationEnvFor(ws, { role }), 'dashboards')
  if (!res.ok) return { ok: false, errors: res.errors }
  return { ok: true, errors: [], dashboard: useEngineStore.getState().add(ws, 'dashboards', body, { ownerId: userId }) }
}

/**
 * "Restore default": drop the user's own copy so they see the shared default again. A personal dashboard that was never
 * forked from a shared one is deleted instead.
 */
export function restoreDefaultDashboard(ws: string, userId: string, dashboardId: string, role?: Role | null): { ok: boolean; error?: string } {
  const r = role === null ? undefined : (role ?? currentRole())
  const store = useEngineStore.getState()
  const target = store.docOf(ws).dashboards.find((d) => d.id === dashboardId)
  if (!target) return { ok: false, error: 'This dashboard no longer exists' }
  if (r && !r.permissions[ENGINE_PERMISSION.dashboards]) return { ok: false, error: `Your role "${r.name}" is not allowed to change dashboards` }
  if (isOwnedBy(target, userId)) {
    store.remove(ws, 'dashboards', target.id)
    return { ok: true }
  }
  store.resetDashboardFor(ws, userId, dashboardId)
  return { ok: true }
}

/** the person has their own copy of this dashboard (so "restore default" has something to undo) */
export const hasOwnCopy = (all: EngineDashboard[], userId: string | undefined, d: EngineDashboard | undefined): boolean => !!d && isOwnedBy(d, userId) && !!d.baseId && all.some((x) => x.id === d.baseId)
