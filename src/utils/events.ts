import type { CrmRecord } from '#/types'

export type RecordEventType = 'created' | 'updated' | 'deleted'

export interface RecordEvent {
  type: RecordEventType
  record: CrmRecord
  previous?: CrmRecord
  /** recursion depth for workflow-triggered writes */
  depth: number
  /** unique per emitted event: a duplicate delivery of the same event carries the same id and is ignored by workflows */
  eventId?: string
  /** ids of the workflows that caused this write, so a workflow can never re-enter itself */
  chain?: string[]
}

type Listener = (e: RecordEvent) => void
const listeners = new Set<Listener>()
let seq = 0

export function onRecordEvent(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function emitRecordEvent(e: RecordEvent) {
  const ev: RecordEvent = { ...e, eventId: e.eventId ?? `evt_${Date.now().toString(36)}_${(seq++).toString(36)}` }
  listeners.forEach((fn) => {
    try {
      fn(ev)
    } catch (err) {
      console.error('record event listener failed', err)
    }
  })
}

/**
 * Changes that move a record in or out of the live set without a field edit: archive, restore, purge.
 * Kept apart from RecordEvent so workflows (which react to created / updated / deleted) are unaffected;
 * the calculation engine listens to both.
 */
export type RecordLifecycleKind = 'archive' | 'unarchive' | 'restore' | 'purge'
export interface RecordLifecycle {
  kind: RecordLifecycleKind
  records: CrmRecord[]
}
const lifecycleListeners = new Set<(e: RecordLifecycle) => void>()

export function onRecordLifecycle(fn: (e: RecordLifecycle) => void): () => void {
  lifecycleListeners.add(fn)
  return () => lifecycleListeners.delete(fn)
}

export function emitRecordLifecycle(e: RecordLifecycle) {
  lifecycleListeners.forEach((fn) => {
    try {
      fn(e)
    } catch (err) {
      console.error('record lifecycle listener failed', err)
    }
  })
}
