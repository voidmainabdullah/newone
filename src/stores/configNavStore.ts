import { create } from 'zustand'
import type { ID } from '#/types'

/**
 * A one-shot hand-off from Studio to the pages that edit a configuration: "Edit" opens the module's Calculations / Rules
 * editor (or the dashboard builder) with the draft already loaded. Whoever consumes it clears it.
 */
export interface ConfigNavState {
  /** calculations / rules: the module page opens this tab (and the editor) on this draft */
  module: { workspaceId: ID; moduleId: string; tab: 'calculations' | 'rules'; body: Record<string, unknown> } | null
  /** dashboards: the dashboards page selects this dashboard and goes straight into edit mode */
  dashboard: { workspaceId: ID; dashboardId: string } | null
  /** only the tab (the link in a chat confirmation) */
  tab: { moduleId: string; tab: 'calculations' | 'rules' } | null
  set: (p: Partial<Omit<ConfigNavState, 'set' | 'clear'>>) => void
  clear: (which: 'module' | 'dashboard' | 'tab') => void
}

export const useConfigNav = create<ConfigNavState>((set) => ({
  module: null,
  dashboard: null,
  tab: null,
  set: (p) => set(p),
  clear: (which) => set({ [which]: null } as Partial<ConfigNavState>),
}))
