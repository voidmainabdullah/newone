import { create } from 'zustand'
import { activeDashboard, isOwnedBy, visibleDashboards } from '#/engine/dashboards'
import { bumpItem, makeItem, replaceItem } from '#/engine/items'
import { emptyDoc, type BodyOf, type ConfigKind, type DashboardBody, type EngineDashboard, type EngineDoc, type ItemOf } from '#/engine/schema'
import { uid } from '#/utils/id'
import { useSettingsStore } from './settingsStore'

/**
 * Persisted engine configuration, one document per workspace (see engine/schema.ts for the shapes).
 *
 * This store is plain CRUD: it bumps `version` and `updatedAt` on every edit and never executes anything. The guarded
 * entry points (validation, cycle rejection, permission checks, output-field creation) live in engine/service.ts.
 * Persistence goes through the same debounced autosave as every other store (stores/index.ts -> engineStorage).
 * Dashboards are stored per workspace AND per user: see engine/dashboards.ts.
 */

interface EngineState {
  docs: EngineDoc[]
  setAll: (docs: EngineDoc[]) => void
  /** the workspace's document (an empty one when nothing was saved yet; reading never writes) */
  docOf: (ws: string) => EngineDoc
  list: <K extends ConfigKind>(ws: string, kind: K) => ItemOf[K][]
  get: <K extends ConfigKind>(ws: string, kind: K, id: string) => ItemOf[K] | undefined
  add: <K extends ConfigKind>(ws: string, kind: K, body: BodyOf[K], meta?: { ownerId?: string; id?: string }) => ItemOf[K]
  /** merge `patch` into the stored item: version + 1, new updatedAt */
  update: <K extends ConfigKind>(ws: string, kind: K, id: string, patch: Partial<BodyOf[K]>) => ItemOf[K] | undefined
  /** replace the whole body (JSON editor save); version + 1 */
  replace: <K extends ConfigKind>(ws: string, kind: K, id: string, body: BodyOf[K]) => ItemOf[K] | undefined
  setEnabled: <K extends ConfigKind>(ws: string, kind: K, id: string, enabled: boolean) => void
  remove: (ws: string, kind: ConfigKind, id: string) => void
  removeByWorkspace: (ws: string) => void
  markScheduledRun: (ws: string, id: string, iso: string) => void
  /** dashboards the user sees (their copies + the shared ones they have not copied) */
  dashboardsFor: (ws: string, userId?: string) => EngineDashboard[]
  activeDashboardFor: (ws: string, userId?: string, id?: string) => EngineDashboard | undefined
  /**
   * Save a layout for a user. A shared dashboard is forked into the user's own copy the first time (other users keep the
   * shared one); a dashboard the user already owns is updated in place.
   */
  saveDashboardFor: (ws: string, userId: string, dashboardId: string, patch: Partial<DashboardBody>) => EngineDashboard | undefined
  /** drop a user's copy so they see the shared dashboard again */
  resetDashboardFor: (ws: string, userId: string, dashboardId: string) => void
}

const currentUser = () => useSettingsStore.getState().settings.currentUserId ?? ''

function patchDoc(docs: EngineDoc[], ws: string, fn: (d: EngineDoc) => EngineDoc): EngineDoc[] {
  const has = docs.some((d) => d.id === ws)
  return has ? docs.map((d) => (d.id === ws ? fn(d) : d)) : [...docs, fn(emptyDoc(ws))]
}

export const useEngineStore = create<EngineState>((set, get) => ({
  docs: [],
  setAll: (docs) => set({ docs }),
  docOf: (ws) => get().docs.find((d) => d.id === ws) ?? emptyDoc(ws),
  list: (ws, kind) => get().docOf(ws)[kind] as ItemOf[typeof kind][],
  get: (ws, kind, id) => (get().docOf(ws)[kind] as { id: string }[]).find((x) => x.id === id) as never,
  add: (ws, kind, body, meta = {}) => {
    const item = makeItem(kind, body, { workspaceId: ws, ownerId: meta.ownerId ?? currentUser(), id: meta.id })
    set((s) => ({ docs: patchDoc(s.docs, ws, (d) => ({ ...d, [kind]: [...(d[kind] as unknown[]), item] })) }))
    return item
  },
  update: (ws, kind, id, patch) => {
    const cur = get().get(ws, kind, id)
    if (!cur) return undefined
    const next = bumpItem(kind, cur, patch)
    set((s) => ({ docs: patchDoc(s.docs, ws, (d) => ({ ...d, [kind]: (d[kind] as { id: string }[]).map((x) => (x.id === id ? next : x)) })) }))
    return next
  },
  replace: (ws, kind, id, body) => {
    const cur = get().get(ws, kind, id)
    if (!cur) return undefined
    const next = replaceItem(kind, cur, body)
    set((s) => ({ docs: patchDoc(s.docs, ws, (d) => ({ ...d, [kind]: (d[kind] as { id: string }[]).map((x) => (x.id === id ? next : x)) })) }))
    return next
  },
  setEnabled: (ws, kind, id, enabled) => {
    get().update(ws, kind, id, { enabled } as never)
  },
  remove: (ws, kind, id) =>
    set((s) => ({
      docs: patchDoc(s.docs, ws, (d) => ({ ...d, [kind]: (d[kind] as { id: string }[]).filter((x) => x.id !== id) })),
    })),
  removeByWorkspace: (ws) => set((s) => ({ docs: s.docs.filter((d) => d.id !== ws) })),
  markScheduledRun: (ws, id, iso) => set((s) => ({ docs: patchDoc(s.docs, ws, (d) => ({ ...d, lastScheduledRun: { ...d.lastScheduledRun, [id]: iso } })) })),
  dashboardsFor: (ws, userId) => visibleDashboards(get().docOf(ws).dashboards, userId),
  activeDashboardFor: (ws, userId, id) => activeDashboard(get().docOf(ws).dashboards, userId, id),
  saveDashboardFor: (ws, userId, dashboardId, patch) => {
    const all = get().docOf(ws).dashboards
    const target = all.find((d) => d.id === dashboardId)
    if (!target) return undefined
    if (isOwnedBy(target, userId)) return get().update(ws, 'dashboards', target.id, { ...patch, autoManaged: false })
    if (target.scope === 'user') return undefined // somebody else's copy
    const { id: _id, version: _v, createdAt: _c, updatedAt: _u, ownerId: _o, workspaceId: _w, ...body } = target
    const copy = makeItem('dashboards', { ...(body as DashboardBody), ...patch, scope: 'user', userId, baseId: target.id, autoManaged: false }, { workspaceId: ws, ownerId: userId, id: uid('dash') })
    set((s) => ({ docs: patchDoc(s.docs, ws, (d) => ({ ...d, dashboards: [...d.dashboards, copy] })) }))
    return copy
  },
  resetDashboardFor: (ws, userId, dashboardId) => {
    const mine = get().docOf(ws).dashboards.find((d) => isOwnedBy(d, userId) && (d.id === dashboardId || d.baseId === dashboardId))
    if (mine) get().remove(ws, 'dashboards', mine.id)
  },
}))