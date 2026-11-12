import { create } from 'zustand'
import type { ID } from '#/types'
import type { Question } from '#/genius/blueprint/schema'
import { autoAnswer, autoAnswerConfigure } from '#/genius/ai/auto-answer'
import { confirmDraft, type ConfigDraft } from '#/genius/service/configure'
import { runGenius, type RunOutput, type StepEvent } from '#/genius/service/run'
import { useConfigNav } from '#/stores/configNavStore'
import { useSelectionStore } from '#/stores/selectionStore'
import { saveConfig } from '#/engine/service'
import { useEngineStore } from '#/stores/engineStore'
import type { ConfigKind, DashboardBody } from '#/engine/schema'
import { useSettingsStore } from '#/stores/settingsStore'
import { httpTransport } from '#/genius/service/transport'
import type { QuestionAnswer } from '#/genius/state/types'
import { uid } from '#/utils/id'
import { sound } from '#/utils/sound'
import { friendlyStatus } from '#/utils/activityText'

/**
 * The conversation of Blitcrm Studio, per workspace. Every line of progress, every question and every answer lives
 * here (and is drawn in the chat column); the preview panel only ever receives the finished design.
 */
export type ChatItem =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; text: string; tone?: 'error' | 'muted'; link?: ChatLink }
  | { id: string; kind: 'steps'; steps: StepEvent[]; running: boolean; startedAt: number; ms?: number; outcome?: TaskOutcome; result?: TaskResult }
  | { id: string; kind: 'qa'; title: string; pairs: { q: string; a: string; auto: boolean }[] }
  | { id: string; kind: 'published'; workspaceId: ID; name: string }

/** how a task ended: done, failed, cancelled by the person, or paused until they answer */
export type TaskOutcome = 'done' | 'failed' | 'cancelled' | 'waiting'
/** what a finished task produced, so the summary never claims more than happened */
export type TaskResult = 'answer' | 'draft' | 'applied' | 'plain'

/** a button under a chat line that opens the page where something was saved */
export interface ChatLink {
  label: string
  to: string
  tab?: 'calculations' | 'rules'
  moduleId?: string
  dashboardId?: string
}

export interface StudioSession {
  chat: ChatItem[]
  running: boolean
  /** a calculation / rule / dashboard drafted from words, waiting for Confirm, Edit or Cancel (nothing is saved yet) */
  config: ConfigDraft | null
  /** the docked questions belong to a configure request (they are never answered by guessing) */
  configuring: boolean
  /** questions that are genuinely ambiguous and shown in the docked card */
  asking: Question[] | null
  /** answers the client already gave silently, sent together with the user's own */
  autoPending: QuestionAnswer[]
  request: string
  proposalId?: string
  retryable: boolean
  /** the request of the task that is working now (the preview picks its wording from it) */
  working?: string
  /** the last finished task changed something the preview shows (build, dashboard, form, UI): the preview opens for it */
  previewHint?: number
}

const EMPTY: StudioSession = { chat: [], running: false, config: null, configuring: false, asking: null, autoPending: [], request: '', retryable: false }

interface StudioState {
  sessions: Record<ID, StudioSession>
  patch: (ws: ID, p: Partial<StudioSession> | ((s: StudioSession) => Partial<StudioSession>)) => void
  push: (ws: ID, item: ChatItem) => void
  reset: (ws: ID) => void
}

export const useStudioStore = create<StudioState>((set) => ({
  sessions: {},
  patch: (ws, p) => set((s) => {
    const cur = s.sessions[ws] ?? EMPTY
    return { sessions: { ...s.sessions, [ws]: { ...cur, ...(typeof p === 'function' ? p(cur) : p) } } }
  }),
  push: (ws, item) => set((s) => {
    const cur = s.sessions[ws] ?? EMPTY
    return { sessions: { ...s.sessions, [ws]: { ...cur, chat: [...cur.chat, item] } } }
  }),
  reset: (ws) => set((s) => ({ sessions: { ...s.sessions, [ws]: { ...EMPTY } } })),
}))

export const useSession = (ws: ID): StudioSession => useStudioStore((s) => s.sessions[ws]) ?? EMPTY

const aborters = new Map<ID, AbortController>()

const MAX_AUTO_ROUNDS = 2

/** Does the request change what the preview shows (a build, dashboard, form, layout)? A plain question does not. */
export const affectsPreview = (request: string): boolean => !/^\s*(what|which|who|when|where|why|how|show me|tell me|explain|list)\b/i.test(request) && !/\?\s*$/.test(request)

/** What went wrong, in plain words: what could not be done, why, and what state any partial change is in. */
export function failureText(what: string, why: string, partial = 'Nothing was changed.'): string {
  const w = what.trim().replace(/\s+/g, ' ')
  const short = w.length > 90 ? `${w.slice(0, 87)}...` : w
  return `I could not complete this: “${short}”.\n\nWhy: ${why.replace(/[.\s]+$/, '')}.\n\nStatus of changes: ${partial}`
}

export async function sendToStudio(ws: ID, text: string, opts: { answers?: QuestionAnswer[]; echo?: boolean; round?: number; stepsId?: string } = {}) {
  const st = useStudioStore.getState()
  const request = text.trim()
  if (!request || (st.sessions[ws]?.running ?? false)) return
  const stepsId = opts.stepsId ?? uid('chat')
  sound.send()
  if (opts.echo !== false) st.push(ws, { id: uid('chat'), kind: 'user', text: request })
  // the follow-up rounds of one task (the app settling obvious details itself) continue the same activity, so its timer keeps the real start
  const continuing = !!opts.stepsId && st.sessions[ws]?.chat.some((c) => c.id === stepsId)
  if (continuing) st.patch(ws, (s) => ({ chat: s.chat.map((c) => (c.id === stepsId && c.kind === 'steps' ? { ...c, running: true, outcome: undefined, ms: undefined } : c)) }))
  else st.push(ws, { id: stepsId, kind: 'steps', steps: [], running: true, startedAt: Date.now() })
  st.patch(ws, { running: true, asking: null, request, working: request, retryable: false, config: null })
  const ctl = new AbortController()
  aborters.set(ws, ctl)
  const update = (fn: (i: Extract<ChatItem, { kind: 'steps' }>) => Extract<ChatItem, { kind: 'steps' }>) =>
    useStudioStore.getState().patch(ws, (s) => ({ chat: s.chat.map((c) => (c.id === stepsId && c.kind === 'steps' ? fn(c) : c)) }))
  let out: RunOutput | null = null
  let failed: string | null = null
  try {
    out = await runGenius({ workspaceId: ws, request, answers: opts.answers, signal: ctl.signal, onStep: (e) => { if (e.status === 'running') sound.step(); update((i) => ({ ...i, steps: i.steps.some((s) => s.id === e.id) ? i.steps.map((s) => (s.id === e.id ? e : s)) : [...i.steps, e] })) } }, { transport: httpTransport })
  } catch (e) {
    if (!ctl.signal.aborted) failed = e instanceof Error ? e.message : 'unknown problem'
  }
  aborters.delete(ws)
  if (ctl.signal.aborted) {
    // cancelStudio already closed the activity at the moment of the click; keep that time
    useStudioStore.getState().patch(ws, { running: false, working: undefined })
    return
  }
  if (failed !== null) {
    update((i) => ({ ...i, running: false, ms: Date.now() - i.startedAt, outcome: 'failed' }))
    useStudioStore.getState().push(ws, { id: uid('chat'), kind: 'assistant', tone: 'error', text: failureText(request, `something went wrong on our side (${failed})`, 'Nothing was changed.') })
    useStudioStore.getState().patch(ws, { retryable: true, running: false, working: undefined })
    return
  }
  update((i) => ({ ...i, running: false, ms: Date.now() - i.startedAt, outcome: 'done' }))
  useStudioStore.getState().patch(ws, { running: false, working: undefined })
  if (out) await handleOutput(ws, request, out, { ...opts, stepsId })
}

/** close the activity of a task with how it ended (the timer stops here) */
function endTask(ws: ID, stepsId: string | undefined, outcome: TaskOutcome, result?: TaskResult) {
  if (!stepsId) return
  useStudioStore.getState().patch(ws, (s) => ({ chat: s.chat.map((c) => (c.id === stepsId && c.kind === 'steps' ? { ...c, running: false, outcome, result: result ?? c.result, ms: c.ms ?? Date.now() - c.startedAt } : c)) }))
}

async function handleOutput(ws: ID, request: string, out: RunOutput, opts: { answers?: QuestionAnswer[]; round?: number; stepsId?: string }) {
  const st = useStudioStore.getState()
  const say = (text: string, tone?: 'error' | 'muted') => st.push(ws, { id: uid('chat'), kind: 'assistant', text, tone })
  const sid = opts.stepsId
  const end = (outcome: TaskOutcome, result?: TaskResult) => endTask(ws, sid, outcome, result)
  if (out.kind === 'configure') {
    st.patch(ws, { config: out.draft, configuring: false, previewHint: Date.now() })
    end('done', 'draft')
    sound.done()
    const d = out.draft
    say(`${d.summary}${d.permission.allowed ? '' : `\n\n${d.permission.message ?? 'Your role is not allowed to make this change.'} You can look at the preview, but only someone with access can confirm it.`}`)
    if (d.permission.allowed) say('The preview on the right shows what it will do on your real records. Nothing is saved until you press Confirm.', 'muted')
    return
  }
  if (out.kind === 'configure_invalid') {
    sound.error()
    st.patch(ws, { configuring: false })
    end('failed')
    const lines = out.errors.slice(0, 5).map((e) => `• ${e.path === '(root)' ? '' : `${e.path}: `}${e.message}`)
    say(`${failureText(request, `the request did not match your existing fields${out.attempts ? ', even after one automatic fix' : ''}`, 'Nothing was saved or changed.')}\n\n${lines.join('\n')}\n\nCheck the field names, or say it another way.`, 'error')
    return
  }
  if (out.kind === 'clarify' && out.intent === 'configure') {
    sound.ask()
    // a configuration is only ever drafted from names the person confirmed: only a question with a single possible answer is settled silently
    const { auto, ask } = autoAnswerConfigure(out.questions)
    if (auto.length) st.push(ws, { id: uid('chat'), kind: 'qa', title: 'Filled in the obvious detail', pairs: auto.map((a) => ({ q: a.question, a: a.answer, auto: true })) })
    if (!ask.length) {
      if ((opts.round ?? 0) >= MAX_AUTO_ROUNDS) {
        end('failed')
        say(failureText(request, 'I could not settle the details on my own', 'Nothing was changed.') + '\n\nSay which fields you mean and send it again.', 'error')
        return
      }
      await sendToStudio(ws, request, { answers: [...(opts.answers ?? []), ...auto], echo: false, round: (opts.round ?? 0) + 1, stepsId: sid })
      return
    }
    st.patch(ws, { asking: ask, autoPending: [...(opts.answers ?? []), ...auto], configuring: true })
    end('waiting')
    say('A few details need fixing. I will not guess between names, so I need one thing from you.')
    return
  }
  if (out.kind === 'clarify') {
    sound.ask()
    const { auto, ask } = autoAnswer(out.questions, request)
    const pairs = auto.map((a) => ({ q: a.question, a: a.answer, auto: true }))
    if (pairs.length) st.push(ws, { id: uid('chat'), kind: 'qa', title: ask.length ? 'Filled in the obvious details' : "Confirmed the CRM's scope and defaults", pairs })
    if (ask.length === 0) {
      if ((opts.round ?? 0) >= MAX_AUTO_ROUNDS) {
        end('failed')
        say(failureText(request, 'I could not settle the details on my own', 'Nothing was changed.') + '\n\nAdd a little more about your business and send it again.', 'error')
        st.patch(ws, { retryable: false })
        return
      }
      await sendToStudio(ws, request, { answers: [...(opts.answers ?? []), ...auto], echo: false, round: (opts.round ?? 0) + 1, stepsId: sid })
      return
    }
    st.patch(ws, { asking: ask, autoPending: [...(opts.answers ?? []), ...auto] })
    end('waiting')
    say("I'll build a practical CRM from this. A couple of details are worth confirming first.")
    return
  }
  if (out.kind === 'proposal') {
    st.patch(ws, { proposalId: out.proposal.id, ...(out.valid ? { previewHint: Date.now() } : {}) })
    const ok = out.valid
    if (ok) sound.done(); else sound.error()
    end(ok ? 'done' : 'failed', ok ? 'draft' : undefined)
    say(ok ? out.proposal.summary || 'Your CRM design is ready.' : failureText(request, friendlyStatus(out.stoppedBecause ?? 'the design still has problems'), 'Nothing was applied. The details are under Review changes.'), ok ? undefined : 'error')
    if (ok) say(out.proposal.kind === 'build' ? 'The preview shows the result with sample data. Press Publish to create it as its own project.' : 'Press Publish to apply this change to the project. You can undo it from History.', 'muted')
    return
  }
  if (out.kind === 'answer') {
    end('done', 'answer')
    say(out.text + (out.references.length ? `\n\nBased on: ${out.references.join(', ')}` : ''))
    return
  }
  if (out.kind === 'restore') {
    end('done', 'plain')
    say(out.text)
    return
  }
  sound.error()
  end('failed')
  say(failureText(request, friendlyStatus(out.message), 'Nothing was changed.'), 'error')
  st.patch(ws, { retryable: out.retryable })
}

export function answerAsked(ws: ID, answers: QuestionAnswer[]) {
  const s = useStudioStore.getState()
  const sess = s.sessions[ws]
  if (!sess) return
  // the task that was waiting for this answer is finished waiting
  s.patch(ws, (x) => ({ chat: x.chat.map((c) => (c.kind === 'steps' && c.outcome === 'waiting' ? { ...c, outcome: 'done' as const } : c)) }))
  s.push(ws, { id: uid('chat'), kind: 'qa', title: sess.configuring ? 'Your answer' : "Confirmed the CRM's core details", pairs: answers.map((a) => ({ q: a.question, a: a.answer, auto: false })) })
  void sendToStudio(ws, sess.request, { answers: [...sess.autoPending, ...answers], echo: false, round: 1 })
}

/** "Skip" takes each question's own default (or its first option) so the build can go on. For a configuration it stops instead: a name is never guessed. */
export function skipAsked(ws: ID) {
  const sess = useStudioStore.getState().sessions[ws]
  if (!sess?.asking) return
  if (sess.configuring) {
    const s = useStudioStore.getState()
    s.patch(ws, { asking: null, configuring: false })
    s.push(ws, { id: uid('chat'), kind: 'assistant', text: 'Okay. I did not build anything. Say which fields you mean whenever you are ready.', tone: 'muted' })
    return
  }
  const at = new Date().toISOString()
  answerAsked(ws, sess.asking.map((q) => ({ questionId: q.id, question: q.question, answer: q.safeDefault ?? q.options[0] ?? 'Use your best judgement', at })))
}

// ---- the configuration draft: Confirm / Edit / Cancel -----------------------------------------------------------------------

const say = (ws: ID, text: string, tone?: 'error' | 'muted', link?: ChatLink) => useStudioStore.getState().push(ws, { id: uid('chat'), kind: 'assistant', text, tone, link })
const setDraft = (ws: ID, d: ConfigDraft | null) => useStudioStore.getState().patch(ws, { config: d })

/**
 * Confirm: save the draft through the engine (validated again, permission checked, versioned, persisted), run it (recalculate
 * the affected records, refresh the widgets) and say where it lives. A role without the permission gets the reason, not a save.
 */
export async function confirmConfig(ws: ID): Promise<boolean> {
  const draft = useStudioStore.getState().sessions[ws]?.config
  if (!draft || draft.status !== 'draft') return false
  if (!draft.permission.allowed) {
    say(ws, `${draft.permission.message ?? 'Your role is not allowed to make this change.'} Nothing was saved. Ask someone with access to confirm it, or use a different role.`, 'error')
    return false
  }
  // the apply gets its own activity: apply -> verify -> done, with the real timer
  const stepsId = uid('chat')
  const startedAt = Date.now()
  const store = useStudioStore.getState()
  store.push(ws, { id: stepsId, kind: 'steps', steps: [{ id: 'apply', label: 'apply', status: 'running' }], running: true, startedAt })
  store.patch(ws, { running: true, working: `apply ${draft.kind}` })
  const setSteps = (steps: StepEvent[]) => useStudioStore.getState().patch(ws, (s) => ({ chat: s.chat.map((c) => (c.id === stepsId && c.kind === 'steps' ? { ...c, steps } : c)) }))
  const finish = (outcome: TaskOutcome, result?: TaskResult) => {
    useStudioStore.getState().patch(ws, (s) => ({ running: false, working: undefined, chat: s.chat.map((c) => (c.id === stepsId && c.kind === 'steps' ? { ...c, running: false, outcome, result, ms: Date.now() - c.startedAt } : c)) }))
  }
  let r: Awaited<ReturnType<typeof confirmDraft>>
  try {
    r = await confirmDraft(draft)
  } catch (e) {
    setSteps([{ id: 'apply', label: 'apply', status: 'error' }])
    finish('failed')
    sound.error()
    say(ws, failureText(`Save the ${kindLabelOf(draft.kind)}`, `something went wrong on our side (${e instanceof Error ? e.message : 'unknown'})`, 'Nothing was saved.'), 'error')
    return false
  }
  if (!r.ok) {
    setSteps([{ id: 'apply', label: 'apply', status: 'error' }])
    finish('failed')
    sound.error()
    say(ws, failureText(`Save the ${kindLabelOf(draft.kind)}`, friendlyStatus(r.message), 'Nothing was saved.'), 'error')
    return false
  }
  setSteps([{ id: 'apply', label: 'apply', status: 'done' }, { id: 'verify', label: 'verify', status: 'running' }])
  // success is only reported once the saved item can be read back from the stored configuration
  const verified = !!r.savedId && !!useEngineStore.getState().get(ws, draft.kind as ConfigKind, r.savedId)
  if (!verified) {
    setSteps([{ id: 'apply', label: 'apply', status: 'done' }, { id: 'verify', label: 'verify', status: 'error' }])
    finish('failed')
    sound.error()
    say(ws, failureText(`Save the ${kindLabelOf(draft.kind)}`, 'it could not be found after saving', 'The change may have been applied. Check History to be sure.'), 'error', { label: 'Open History', to: '/history' })
    return false
  }
  setSteps([{ id: 'apply', label: 'apply', status: 'done' }, { id: 'verify', label: 'verify', status: 'done' }])
  finish('done', 'applied')
  sound.done()
  setDraft(ws, { ...draft, status: 'saved', savedId: r.savedId })
  say(ws, `${r.message}${r.warnings.length ? `\n\n${r.warnings.join(' ')}` : ''}\n\nYou can undo this from History.`, undefined, r.link ? { label: r.link.label, to: r.link.to, tab: r.link.tab, moduleId: r.link.moduleId, dashboardId: r.link.dashboardId } : undefined)
  return true
}

const kindLabelOf = (k: string) => (k === 'calculations' ? 'calculation' : k === 'conditional_rules' ? 'rule' : 'dashboard')

export function cancelConfig(ws: ID) {
  const draft = useStudioStore.getState().sessions[ws]?.config
  if (!draft || draft.status !== 'draft') return
  setDraft(ws, null)
  say(ws, 'Cancelled. Nothing was saved or changed.', 'muted')
}

/**
 * Edit: hand the draft to the editor that already exists for it. A calculation or rule opens in the module's Calculations /
 * Rules editor with the draft loaded (nothing is saved until Save there). A dashboard has no unsaved editor, so it is saved
 * as the person's own dashboard (validated, permission checked) and opened in the dashboard builder to adjust.
 * Returns the page to go to, or null when it could not be opened.
 */
export function editConfig(ws: ID): string | null {
  const draft = useStudioStore.getState().sessions[ws]?.config
  if (!draft || draft.status !== 'draft') return null
  if (!draft.permission.allowed) {
    say(ws, `${draft.permission.message ?? 'Your role is not allowed to make this change.'} The editor would not let you save it either.`, 'error')
    return null
  }
  if (draft.kind === 'dashboards') {
    const userId = useSettingsStore.getState().settings.currentUserId ?? ''
    const res = saveConfig(ws, { ...(draft.body as DashboardBody), scope: 'user', userId }, { expected: 'dashboards', ownerId: userId })
    if (!res.ok || !res.item) {
      say(ws, `Could not open it in the dashboard builder. ${res.errors[0]?.message ?? ''}`.trim(), 'error')
      return null
    }
    useSelectionStore.getState().set({ dashboardId: res.item.id })
    useConfigNav.getState().set({ dashboard: { workspaceId: ws, dashboardId: res.item.id } })
    setDraft(ws, { ...draft, status: 'saved', savedId: res.item.id })
    say(ws, `Opened as your own dashboard “${(draft.body as DashboardBody).name}” in the builder. Adjust the widgets there; it is already saved, and you can delete it from the dashboard menu.`, 'muted')
    return '/dashboards'
  }
  const moduleId = draft.entity ?? (draft.body as { entity?: string }).entity
  if (!moduleId) return null
  useConfigNav.getState().set({ module: { workspaceId: ws, moduleId, tab: draft.kind === 'calculations' ? 'calculations' : 'rules', body: draft.body as unknown as Record<string, unknown> } })
  setDraft(ws, null)
  say(ws, `Opened in the ${draft.kind === 'calculations' ? 'Calculations' : 'Rules'} editor with your draft loaded. Nothing is saved until you press Save there.`, 'muted')
  return `/m/${moduleId}`
}

/**
 * Stop the task that is running. The timer stops right here. Changes that were already applied before the click stay
 * (they are not reversed); the chat says so and points to History for undo.
 */
export function cancelStudio(ws: ID) {
  const sess = useStudioStore.getState().sessions[ws]
  if (!sess?.running) return
  aborters.get(ws)?.abort()
  useStudioStore.getState().patch(ws, (s) => ({ running: false, working: undefined, chat: s.chat.map((c) => (c.kind === 'steps' && c.running ? { ...c, running: false, outcome: 'cancelled' as const, ms: Date.now() - c.startedAt } : c)) }))
  say(ws, 'Task cancelled. None of its changes had been applied. Changes applied earlier are not reversed; you can undo them from History.', 'muted', { label: 'Open History', to: '/history' })
}
