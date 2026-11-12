import { useEffect, useMemo, useState } from 'react'
import { Info } from 'lucide-react'
import { useModules, usePageTitle, usePerms, useWorkspace, useWsId } from '#/hooks/useData'
import { readConfig } from '#/genius/config/storePort'
import { applyProposal } from '#/genius/service/actions'
import { fetchHealth } from '#/genius/service/transport'
import { useGeniusStore } from '#/genius/state/geniusStore'
import type { HealthInfo } from '#/genius/server/handlers'
import { useGo } from '#/components/layout/AppLink'
import { StudioView } from '#/components/studio/StudioView'
import { ReviewPanel } from '#/components/studio/ReviewPanel'
import { fromBlueprint, fromModules, stashPreview, type PApp } from '#/components/studio/previewModel'
import { answerAsked, cancelConfig, cancelStudio, confirmConfig, editConfig, sendToStudio, skipAsked, useSession, useStudioStore, type ChatLink } from '#/stores/studioStore'
import { ConfigCard } from '#/components/studio/ConfigCard'
import { useConfigNav } from '#/stores/configNavStore'
import { useSelectionStore } from '#/stores/selectionStore'
import { useWorkspaceStore } from '#/stores/workspaceStore'
import { useUiStore } from '#/stores/uiStore'
import { isHomeWorkspace } from '#/services/workspaceService'
import { confirmDialog, toast } from '#/utils/toast'
import { uid } from '#/utils/id'

/** Blitcrm Studio: describe a CRM, see it appear on the right, publish it as its own project. */
export function GeniusPage() {
  const ws = useWsId()
  const workspace = useWorkspace()
  const all = useWorkspaceStore((s) => s.workspaces)
  const go = useGo()
  const perms = usePerms()
  const session = useSession(ws)
  const modules = useModules()
  const proposals = useGeniusStore((s) => s.proposals)
  const [health, setHealth] = useState<HealthInfo | 'unreachable' | null>(null)
  const [publishing, setPublishing] = useState(false)
  usePageTitle('Genius Studio · Blitcrm')

  useEffect(() => {
    let live = true
    fetchHealth().then((h) => live && setHealth(h)).catch(() => live && setHealth('unreachable'))
    return () => { live = false }
  }, [])

  const home = workspace ? isHomeWorkspace(workspace, all) : true
  const proposal = session.proposalId ? proposals.find((p) => p.id === session.proposalId) : undefined
  const published = [...session.chat].reverse().find((c) => c.kind === 'published')
  const canBuild = perms.can('manageFields')

  const app = useMemo<PApp | null>(() => {
    if (proposal?.blueprint) return fromBlueprint(proposal.blueprint)
    if (!home && modules.length) return fromModules(workspace?.name ?? 'Project', modules)
    return null
  }, [proposal, home, modules, workspace?.name])

  const publishable = !!proposal && proposal.state === 'validated' && canBuild
  const done = proposal?.state === 'accepted' || proposal?.state === 'superseded'

  const publish = async () => {
    if (!proposal || publishing) return
    const destructive = proposal.changes.filter((c) => c.destructive)
    if (destructive.length && !(await confirmDialog({ title: 'This change removes parts of the project', message: `${destructive.map((c) => c.label).slice(0, 5).join('; ')}. Your records are kept, but these definitions go away. You can undo it from History.`, confirmLabel: 'Apply', danger: true }))) return
    setPublishing(true)
    const r = applyProposal(proposal.id, { confirmDestructive: destructive.length > 0 })
    setPublishing(false)
    if (!r.ok) {
      toast.error('Nothing was changed', r.error)
      return
    }
    const newWs = (r as { workspaceId?: string }).workspaceId
    if (newWs && newWs !== ws) {
      const name = useWorkspaceStore.getState().workspaces.find((w) => w.id === newWs)?.name ?? 'New project'
      useStudioStore.getState().push(ws, { id: uid('chat'), kind: 'published', workspaceId: newWs, name })
      toast.success('Project published', `“${name}” is in My projects.`)
    } else toast.success(r.duplicate ? 'Already applied' : 'Change applied', 'You can undo it from History.')
  }

  const openPublished = () => {
    if (published?.kind !== 'published') return
    useWorkspaceStore.getState().setCurrent(published.workspaceId)
    go('/genius')
  }

  /** the button under "Saved the calculation…": the module's tab, or the dashboard that was just saved */
  const openLink = (l: ChatLink) => {
    if (l.moduleId && l.tab) useConfigNav.getState().set({ tab: { moduleId: l.moduleId, tab: l.tab } })
    if (l.dashboardId) useSelectionStore.getState().set({ dashboardId: l.dashboardId })
    go(l.to)
  }

  const projects = all.filter((w) => !isHomeWorkspace(w, all)).map((w) => ({ id: w.id, name: w.name, current: w.id === ws }))

  const pickProject = (id: string) => {
    if (id === 'new') {
      useUiStore.getState().setNewProjectOpen(true)
      return
    }
    useWorkspaceStore.getState().setCurrent(id)
  }

  const share = () => {
    if (!app || !stashPreview(app)) return
    void navigator.clipboard?.writeText(`${location.origin}/preview`)
    toast.info('Preview link copied', 'It opens the latest preview in this browser.')
  }
  const openTab = () => {
    if (app && stashPreview(app)) window.open('/preview', '_blank', 'noopener')
  }

  const notice =
    health === 'unreachable' ? (
      <Note>The AI service could not be reached. Renaming, explaining and undo still work.</Note>
    ) : health && !health.geminiConfigured ? (
      <Note>AI is not connected yet. Add GEMINI_API_KEY to the server to turn building on. Exact changes still work.</Note>
    ) : !canBuild ? (
      <Note>Your role can ask questions but cannot publish changes.</Note>
    ) : null

  return (
    <StudioView
      title={home ? 'New project' : (workspace?.name ?? 'Project')}
      projects={projects}
      onPickProject={pickProject}
      onHistory={() => go('/history')}
      onNewChat={() => { useStudioStore.getState().reset(ws) }}
      chat={session.chat}
      running={session.running}
      asking={session.asking}
      working={session.working}
      previewHint={session.previewHint}
      onSend={(t) => void sendToStudio(ws, t)}
      onCancel={() => cancelStudio(ws)}
      onAnswers={(a) => answerAsked(ws, a)}
      onSkip={() => skipAsked(ws)}
      notice={notice}
      onRetry={session.retryable && session.request ? () => void sendToStudio(ws, session.request, { echo: false }) : undefined}
      published={published?.kind === 'published' ? { name: published.name, onOpen: openPublished } : null}
      app={app}
      config={session.config ? { id: session.config.id, card: <ConfigCard draft={session.config} modules={modules} onConfirm={() => void confirmConfig(ws)} onEdit={() => { const to = editConfig(ws); if (to) go(to) }} onCancel={() => cancelConfig(ws)} /> } : null}
      onLink={openLink}
      review={proposal ? <ReviewPanel proposal={proposal} cfg={readConfig(ws)} /> : null}
      publish={{ label: done ? 'Published' : home || proposal?.kind === 'build' ? 'Publish' : 'Apply', disabled: !publishable || done, busy: publishing, onClick: () => void publish() }}
      onShare={share}
      onOpenTab={openTab}
      onMenu={() => useUiStore.getState().setMobileNav(true)}
    />
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="flex items-start gap-2 px-1 text-xs leading-relaxed text-muted-2"><Info size={13} className="mt-0.5 shrink-0" />{children}</p>
}
