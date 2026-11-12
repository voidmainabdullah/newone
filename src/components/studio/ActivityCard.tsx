import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, ChevronDown } from 'lucide-react'
import type { ChatItem } from '#/stores/studioStore'
import { activityLines, currentActivity, STATUS_DONE_APPLIED, STATUS_DONE_PLAIN, STATUS_DONE_READY, STATUS_FIX_NEEDED, STATUS_STOPPED } from '#/utils/activityText'
import { formatElapsed } from '#/utils/duration'
import { cn } from '#/utils/id'

type Steps = Extract<ChatItem, { kind: 'steps' }>

const AUTO_CLOSE_MS = 3000

/** a ticking clock that only runs while `on`; the display stops on the exact value the task ended with */
export function useElapsed(item: Pick<Steps, 'running' | 'startedAt' | 'ms'>): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!item.running) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [item.running])
  return item.running ? Math.max(0, now - item.startedAt) : (item.ms ?? 0)
}

export function doneText(result: Steps['result']): string {
  return result === 'applied' ? STATUS_DONE_APPLIED : result === 'draft' ? STATUS_DONE_READY : STATUS_DONE_PLAIN
}

/** the headline: how long it has been going, or how it ended */
export function headline(item: Steps, elapsed: string): string {
  if (item.running) return `Working · ${elapsed}`
  if (item.outcome === 'waiting') return 'Waiting for your answer'
  if (item.outcome === 'failed') return `Stopped after ${elapsed}`
  if (item.outcome === 'cancelled') return `Cancelled after ${elapsed}`
  return `Completed in ${elapsed}`
}

/**
 * The activity of one task, as a compact dropdown. It opens when the task starts and closes itself after 3 seconds. Once
 * the person has opened it themselves it stays open until they close it, and later stages only change the compact status
 * line (they never reopen it). The finished activity stays in the chat to be read again.
 */
export function ActivityCard({ item }: { item: Steps }) {
  const [open, setOpen] = useState(item.running)
  const touched = useRef(false)
  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => { if (!touched.current) setOpen(false) }, AUTO_CLOSE_MS)
    return () => clearTimeout(t)
    // only the first opening (the task starting) is automatic
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const elapsed = formatElapsed(useElapsed(item))
  const lines = activityLines(item.steps)
  const waiting = !item.running && item.outcome === 'waiting'
  const failed = !item.running && item.outcome === 'failed'
  const cancelled = !item.running && item.outcome === 'cancelled'
  const finished = !item.running && !waiting && !failed && !cancelled
  const status = item.running ? currentActivity(item.steps) : waiting ? STATUS_FIX_NEEDED : failed ? STATUS_FIX_NEEDED : cancelled ? STATUS_STOPPED : doneText(item.result)
  const toggle = () => {
    // opening it by hand takes over: nothing closes it until the person does
    if (!open) touched.current = true
    setOpen((o) => !o)
  }
  return (
    <div className="rise-in" data-testid="activity-card" data-state={item.running ? 'running' : (item.outcome ?? 'done')}>
      <button type="button" aria-expanded={open} onClick={toggle} className="group flex w-full items-center gap-2.5 rounded-lg py-1.5 text-left text-[13px] transition hover:bg-surface/60 sm:px-1">
        <Dot state={item.running ? 'running' : failed ? 'failed' : waiting ? 'waiting' : cancelled ? 'cancelled' : 'done'} />
        <span className="min-w-0 flex-1">
          <span className="block font-medium tabular-nums">{headline(item, elapsed)}</span>
          {!open && <span key={status} className="blur-in block truncate text-xs text-muted">{status}</span>}
        </span>
        <ChevronDown size={15} className={cn('shrink-0 text-muted transition-transform duration-300', open && 'rotate-180')} />
      </button>
      <div className={cn('grid transition-[grid-template-rows,opacity] duration-300 ease-out', open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0')} aria-hidden={!open}>
        <div className="overflow-hidden">
          <ol aria-label="Activity" className="relative ml-[7px] space-y-2.5 border-l border-line py-2 pl-5">
            {lines.length === 0 && <li className="text-xs text-muted">Getting started...</li>}
            {lines.map((l) => (
              <li key={l.key} className="rise-in relative text-[13px]">
                <span className="absolute top-[7px] -left-[24.5px] flex size-2 items-center justify-center rounded-full bg-app ring-4 ring-app">
                  <span className={cn('size-2 rounded-full', l.status === 'error' ? 'bg-danger' : l.status === 'running' ? 'bg-link motion-safe:animate-pulse' : 'bg-success')} />
                </span>
                <span className={cn(l.status === 'running' ? 'text-fg' : l.status === 'error' ? 'text-fg' : 'text-muted')}>{l.text}</span>
              </li>
            ))}
            {finished && (
              <li className="rise-in relative text-[13px] text-fg">
                <span className="absolute top-[3px] -left-[28px] flex size-4 items-center justify-center rounded-full bg-app"><Check size={13} className="text-success" /></span>
                {doneText(item.result)}
              </li>
            )}
            {failed && (
              <li className="rise-in relative text-[13px] text-fg">
                <span className="absolute top-[3px] -left-[28px] flex size-4 items-center justify-center rounded-full bg-app"><AlertTriangle size={12} className="text-danger" /></span>
                This could not be completed
              </li>
            )}
            {waiting && <li className="relative text-[13px] text-fg"><span className="absolute top-[7px] -left-[24.5px] size-2 rounded-full bg-warning ring-4 ring-app" />Waiting for your answer</li>}
          </ol>
        </div>
      </div>
    </div>
  )
}

function Dot({ state }: { state: 'running' | 'failed' | 'waiting' | 'cancelled' | 'done' }) {
  if (state === 'done') return <span className="flex size-4 shrink-0 items-center justify-center"><Check size={14} className="text-success" /></span>
  if (state === 'failed') return <span className="flex size-4 shrink-0 items-center justify-center"><AlertTriangle size={13} className="text-danger" /></span>
  return (
    <span className="relative flex size-4 shrink-0 items-center justify-center" aria-hidden>
      {state === 'running' && <span className="absolute size-3 rounded-full bg-link/30 motion-safe:animate-ping" />}
      <span className={cn('size-2 rounded-full', state === 'running' ? 'bg-link' : state === 'waiting' ? 'bg-warning' : 'bg-muted-2')} />
    </span>
  )
}
