import { create } from 'zustand'

/** What the last run of a calculation / rule did. Runtime information: never persisted, shown next to the config. */
export interface ConfigStatus {
  lastRunAt: string
  ok: boolean
  /** the most recent problem (unknown field, refused write, cascade cap...) */
  error?: string
  /** records evaluated since the app opened */
  records: number
  /** record fields actually changed */
  writes: number
}

interface StatusState {
  status: Record<string, ConfigStatus>
  merge: (patch: Record<string, ConfigStatus>) => void
  clear: () => void
}

export const useEngineStatus = create<StatusState>((set) => ({
  status: {},
  merge: (patch) => set((s) => ({ status: { ...s.status, ...patch } })),
  clear: () => set({ status: {} }),
}))
