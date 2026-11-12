import { useMemo, useState } from 'react'
import { FolderKanban, History, Menu as MenuIcon, MessageSquare } from 'lucide-react'
import { useStudioStore } from '#/stores/studioStore'
import { useWorkspaceStore } from '#/stores/workspaceStore'
import { useGo } from '#/components/layout/AppLink'
import { StudioTile } from '#/components/layout/GeniusStudioButton'
import { ThemeToggle } from '#/components/layout/ThemeToggle'
import { cn } from '#/utils/id'
import { Composer } from './Composer'
import { LandingDock } from './LandingDock'
import { MODES, SUGGESTIONS, type LandingMode } from './landingData'

function IconBtn({ label, onClick, className, children }: { label: string; onClick: () => void; className?: string; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className={cn('flex size-8 items-center justify-center rounded-lg text-muted transition hover:bg-surface hover:text-fg', className)}>{children}</button>
  )
}

/** Earlier conversations from every project, newest project first. */
function useRecentChats() {
  const sessions = useStudioStore((s) => s.sessions)
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  return useMemo(() => {
    const out: { wsId: string; title: string; project: string }[] = []
    for (const [wsId, s] of Object.entries(sessions)) {
      const first = s.chat.find((c) => c.kind === 'user')
      if (!first || first.kind !== 'user') continue
      out.push({ wsId, title: first.text.replace(/\s+/g, ' ').trim(), project: workspaces.find((w) => w.id === wsId)?.name ?? 'Project' })
    }
    return out.reverse().slice(0, 4)
  }, [sessions, workspaces])
}

/**
 * The empty Genius Studio screen: a faint colour glow along the top edge, the brand mark, mode tabs that merge into a large
 * message box (with its slow gradient outline), a short explanation, recent chats, suggestions and a dock of quick starts.
 */
export function GeniusLanding({ onSend, onCancel, running, onMenu }: { onSend: (t: string) => void; onCancel: () => void; running: boolean; onMenu?: () => void }) {
  const go = useGo()
  const [mode, setMode] = useState<LandingMode>('ask')
  const [seed, setSeed] = useState<string | undefined>()
  const recent = useRecentChats()
  const setCurrent = useWorkspaceStore((s) => s.setCurrent)

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-app" data-testid="genius-intro">
      <div className="landing-glow" aria-hidden />

      <div className="relative z-10 flex h-12 shrink-0 items-center justify-between px-3">
        <div className="flex items-center gap-1">
          {onMenu && <IconBtn label="Open menu" onClick={onMenu} className="lg:hidden"><MenuIcon size={17} /></IconBtn>}
          <IconBtn label="History" onClick={() => go('/history')}><History size={17} /></IconBtn>
        </div>
        <div className="flex items-center gap-1">
          <IconBtn label="My projects" onClick={() => go('/projects')}><FolderKanban size={17} /></IconBtn>
          <ThemeToggle />
        </div>
      </div>

      <div className="scroll-thin relative z-[1] min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-[720px] flex-col items-center px-5 pt-4 pb-6">
          <div className="landing-icon rise-in" aria-hidden>
            <img src="/brand/icon.png" alt="" width={56} height={56} className="relative size-14 object-contain" />
          </div>
          <h1 className="sr-only">Genius Studio</h1>

          <div className="rise-in mt-7 w-full [animation-delay:0.08s]">
            <div role="tablist" aria-label="What would you like to do?" className="relative z-10 -mb-px flex items-end gap-1 pl-3">
              {MODES.map((m) => {
                const on = m.id === mode
                return (
                  <button
                    key={m.id}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    onClick={() => setMode(m.id)}
                    className={cn(
                      'h-8 rounded-t-xl px-3.5 text-[13px] transition motion-reduce:transition-none',
                      on ? 'border border-b-0 border-line bg-surface font-medium text-fg' : 'mb-0.5 rounded-full text-muted hover:bg-surface hover:text-fg',
                    )}
                  >
                    {m.label}
                  </button>
                )
              })}
            </div>
            <Composer hero running={running} onSend={onSend} onCancel={onCancel} seed={seed} onSeedUsed={() => setSeed(undefined)} mode={mode} onMode={setMode} />
          </div>

          <div className="rise-in mt-4 flex w-full items-center gap-3 rounded-2xl border border-line bg-surface/60 px-4 py-3 [animation-delay:0.16s]">
            <StudioTile size={30} />
            <p className="text-[13px] leading-snug text-muted">Genius Studio builds and edits your CRM for you. Describe what you need in plain English.</p>
          </div>

          <div className="rise-in mt-6 grid w-full gap-6 text-left [animation-delay:0.22s] sm:grid-cols-2">
            <section aria-label="Recent chats">
              <h2 className="mb-2 px-1 text-xs font-medium text-muted-2">Recent chats</h2>
              {recent.length === 0 ? (
                <p className="px-1 text-[13px] text-muted-2">Your recent chats will show up here.</p>
              ) : (
                <ul className="space-y-0.5">
                  {recent.map((r) => (
                    <li key={r.wsId}>
                      <button type="button" onClick={() => setCurrent(r.wsId)} className="flex w-full items-start gap-2 rounded-lg px-1 py-1.5 text-left transition hover:bg-surface">
                        <MessageSquare size={14} className="mt-0.5 shrink-0 text-muted-2" />
                        <span className="min-w-0">
                          <span className="block truncate text-[13px] text-fg">{r.title}</span>
                          <span className="block truncate text-[11px] text-muted-2">{r.project}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section aria-label="Suggestions">
              <h2 className="mb-2 px-1 text-xs font-medium text-muted-2">Suggestions</h2>
              <ul className="space-y-0.5">
                {SUGGESTIONS[mode].map((t) => (
                  <li key={t}>
                    <button type="button" onClick={() => setSeed(t)} className="w-full rounded-lg px-1 py-1.5 text-left text-[13px] text-muted transition hover:bg-surface hover:text-fg">{t}</button>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          <div className="rise-in mt-auto w-full pt-10 [animation-delay:0.28s]">
            <LandingDock onPick={(prompt, m) => { setMode(m); setSeed(prompt) }} />
          </div>
        </div>
      </div>
    </div>
  )
}
