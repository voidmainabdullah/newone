import { useMemo } from 'react'
import { ChevronDown, Maximize2, X } from 'lucide-react'
import { useWsId } from '#/hooks/useData'
import { useStudioLayout } from '#/stores/studioLayoutStore'
import { useConfigNav } from '#/stores/configNavStore'
import { useSelectionStore } from '#/stores/selectionStore'
import { answerAsked, cancelStudio, sendToStudio, skipAsked, useSession, type ChatLink } from '#/stores/studioStore'
import { formatElapsed } from '#/utils/duration'
import { cn } from '#/utils/id'
import { useGo } from '#/components/layout/AppLink'
import { StudioTile } from '#/components/layout/GeniusStudioButton'
import { useElapsed, headline } from './ActivityCard'
import { ChatColumn } from './ChatColumn'

const STARTERS = ['Create a new contact form', 'Create a revenue dashboard', 'How many contacts do I have?']

/**
 * The floating Genius AI button (bottom right, on every page except the Genius page) and its chat panel. It reads the very same
 * session as the Genius page and the Ask AI button, so it is one conversation: minimise or close the panel and it is all still
 * there when it comes back.
 */
export function GeniusLauncher() {
  const ws = useWsId()
  const session = useSession(ws)
  const go = useGo()
  const state = useStudioLayout((s) => s.launcher)
  const setState = useStudioLayout((s) => s.setLauncher)
  const latest = useMemo(() => [...session.chat].reverse().find((c) => c.kind === 'steps'), [session.chat])
  const steps = latest && latest.kind === 'steps' ? latest : null
  const elapsed = useElapsed(steps ?? { running: false, startedAt: 0 })

  const openLink = (l: ChatLink) => {
    if (l.moduleId && l.tab) useConfigNav.getState().set({ tab: { moduleId: l.moduleId, tab: l.tab } })
    if (l.dashboardId) useSelectionStore.getState().set({ dashboardId: l.dashboardId })
    go(l.to)
  }

  const status = session.running && steps ? headline(steps, formatElapsed(elapsed)) : session.asking ? 'Waiting for your answer' : null

  return (
    <div className="no-print">
      {state === 'open' && (
        <section aria-label="Genius Studio" className="launcher-in fixed right-4 bottom-20 z-40 flex h-[min(640px,calc(100vh-7rem))] w-[400px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-line bg-app shadow-[0_24px_60px_-12px_rgba(0,0,0,0.65)]" data-testid="launcher-panel">
          <div className="flex h-12 shrink-0 items-center gap-2 px-3.5">
            <StudioTile size={26} />
            <div className="min-w-0 flex-1 leading-tight">
              <div className="text-[13.5px] font-medium">Genius Studio</div>
              {status && <div className="truncate text-[11px] text-muted tabular-nums">{status}</div>}
            </div>
            <PanelBtn label="Open on the full page" onClick={() => { setState('closed'); go('/genius') }}><Maximize2 size={14} /></PanelBtn>
            <PanelBtn label="Minimise" onClick={() => setState('minimized')}><ChevronDown size={16} /></PanelBtn>
            <PanelBtn label="Close" onClick={() => setState('closed')}><X size={15} /></PanelBtn>
          </div>
          <ChatColumn
            chat={session.chat}
            running={session.running}
            asking={session.asking}
            onSend={(t) => void sendToStudio(ws, t)}
            onCancel={() => cancelStudio(ws)}
            onAnswers={(a) => answerAsked(ws, a)}
            onSkip={() => skipAsked(ws)}
            onLink={openLink}
            footer={session.chat.length === 0 ? (
              <div className="pt-6 text-center">
                <p className="text-sm font-medium">Ask Genius Studio anything</p>
                <p className="mt-1 text-xs text-muted">Build, change, add data or get an answer.</p>
                <ul className="mt-4 flex flex-wrap justify-center gap-1.5">
                  {STARTERS.map((s) => <li key={s}><button type="button" onClick={() => void sendToStudio(ws, s)} className="rounded-full bg-surface px-3 py-1.5 text-xs text-muted transition hover:bg-subtle hover:text-fg">{s}</button></li>)}
                </ul>
              </div>
            ) : undefined}
          />
        </section>
      )}

      <div className="fixed right-4 bottom-4 z-40 flex items-center gap-2">
        {state === 'minimized' && status && (
          <button type="button" onClick={() => setState('open')} className="launcher-in max-w-[220px] truncate rounded-full bg-surface px-3.5 py-2 text-xs text-muted shadow-pop transition hover:bg-subtle hover:text-fg tabular-nums">{status}</button>
        )}
        <button
          type="button"
          aria-label={state === 'open' ? 'Minimise Genius Studio' : 'Open Genius Studio'}
          aria-expanded={state === 'open'}
          onClick={() => setState(state === 'open' ? 'minimized' : 'open')}
          className={cn('gs-btn size-12 !rounded-full', session.running && 'motion-safe:animate-pulse')}
          data-testid="launcher-button"
        >
          <span className="gs-face justify-center !rounded-full"><StudioTile size={34} className="!rounded-full" /></span>
        </button>
      </div>
    </div>
  )
}

function PanelBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" aria-label={label} title={label} onClick={onClick} className="flex size-8 items-center justify-center rounded-lg text-muted transition hover:bg-surface hover:text-fg">{children}</button>
}
