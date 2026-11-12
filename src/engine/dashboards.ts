import type { EngineDashboard } from './schema'

/**
 * Which dashboards a user sees. Pure functions over a workspace's dashboard list.
 *
 *  - a 'workspace' dashboard is the shared default of the project (every user starts with it);
 *  - the first time a user edits it, the edit is saved as that user's own copy ('user' scope, `userId`, `baseId` = the shared one);
 *  - from then on that user sees their copy instead of the shared one. Other users are unaffected.
 */

export const isOwnedBy = (d: EngineDashboard, userId: string | undefined): boolean => d.scope === 'user' && !!userId && d.userId === userId

/** Dashboards visible to `userId`: their own copies, plus the shared ones they have not copied. */
export function visibleDashboards(all: EngineDashboard[], userId: string | undefined): EngineDashboard[] {
  const mine = all.filter((d) => isOwnedBy(d, userId))
  const forked = new Set(mine.map((d) => d.baseId).filter(Boolean))
  const shared = all.filter((d) => d.scope !== 'user' && !forked.has(d.id))
  return [...shared, ...mine].filter((d) => d.enabled)
}

/** The dashboard a user lands on: their copy of the default, else the shared default, else the first visible one. */
export function activeDashboard(all: EngineDashboard[], userId: string | undefined, id?: string): EngineDashboard | undefined {
  const list = visibleDashboards(all, userId)
  if (id) {
    const exact = list.find((d) => d.id === id) ?? list.find((d) => d.baseId === id)
    if (exact) return exact
  }
  return list.find((d) => d.isDefault) ?? list[0]
}
