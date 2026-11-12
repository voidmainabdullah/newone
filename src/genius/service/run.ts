import type { ID } from '#/types'
import { Question, SCHEMA_VERSION } from '../blueprint/schema'
import { BLUEPRINT_VERSION } from '../blueprint/schema'
import { projectIdFor } from '../compiler/ids'
import { hash53, revisionOf, type ConfigModel } from '../config/model'
import { readConfig, readRecords } from '../config/storePort'
import { recordDigest } from '../ai/record-digest'
import { useUserStore } from '#/stores/userStore'
import { sanitizeModelOutput } from '../ai/generate'
import { currencyOfConfig } from './currency'
import { answersAsRequirements, currencyFromAnswers, filterQuestions, preflight } from '../ai/clarification'
import { memoryForPrompt, summarizeProject } from '../ai/context-manager'
import { retrieveContext } from '../ai/context-retriever'
import { parseIntent, type Intent } from '../ai/intent-parser'
import { routeModel, type Route } from '../ai/model-router'
import { estimateTokens, newCorrelationId } from '../ai/observability'
import { fitContext } from '../ai/token-optimizer'
import { MAX_REQUEST_CHARS } from '../ai/wire'
import { applyFragments, planFragments, type FragmentRequest } from './fragment-repair'
import type { GenerateResponse, GenerateWire, Transport, TransportFailure } from '../ai/wire'
import { currentActor, submitProposal, validationContext } from './builder'
import { explainCalculation, restoreTarget, simulateWorkflow, type RestoreTarget } from './readonly'
import { runConfigure, type ConfigDraft } from './configure'
import { simplePatch } from './simple-patch'
import { useGeniusStore } from '../state/geniusStore'
import type { Proposal, QuestionAnswer, UsageTotals } from '../state/types'
import { getTenantId } from '../tenant'
import { errorSignature, type Issue } from '../validation/issues'
import { validateBlueprint, validatePatch, type ValidationOutcome } from '../validation'

/**
 * The Studio pipeline, client side. Every step reported through `onStep` is a REAL piece of work: a local computation or
 * a server round trip, with its measured duration. Nothing is animated.
 *
 *   understand (deterministic intent) -> [deterministic handlers: explain / simulate / restore / simple patch]
 *   -> clarify (only costly ambiguity) -> context (retrieval) -> route (model tier) -> design (server: Gemini)
 *   -> validate (6 stages, local) -> repair (server, bounded) -> proposal (nothing is written until the user accepts)
 *
 * Validation and the repair loop run here because the configuration lives here; the server only ever sees the compact
 * context, never records, and never decides what gets applied.
 */
export const MAX_REPAIR_ATTEMPTS = 2
/** targeted repairs of just the invalid fragments; separate from, and tried before, the full-design repair */
export const MAX_FRAGMENT_ATTEMPTS = 2
const CONTEXT_BUDGET_TOKENS = 14_000

export type StepId = 'understand' | 'handle' | 'clarify' | 'context' | 'route' | 'design' | 'validate' | 'repair' | 'prepare' | 'find' | 'build' | 'preview' | 'apply' | 'verify' | 'summary'
export interface StepEvent {
  id: StepId
  label: string
  status: 'running' | 'done' | 'skipped' | 'error'
  detail?: string
  ms?: number
}

export interface RunInput {
  workspaceId: ID
  request: string
  /** answers to earlier clarifying questions; they are remembered and never asked again */
  answers?: QuestionAnswer[]
  onStep?: (e: StepEvent) => void
  /** abort a run in flight (the UI cancel button) */
  signal?: AbortSignal
}

export interface RunDeps {
  transport: Transport
  now?: () => Date
}

/** What the validator reported, in the form the UI and the repair step both use. */
export interface ErrorView {
  code: string
  stage: string
  path: string
  message: string
  allowed?: string[]
  received?: unknown
  suggested?: unknown
  /** did an automatic repair clear it? */
  fixed?: boolean
  userActionRequired?: boolean
}
export interface RepairAttempt {
  n: number
  mode: 'fragment' | 'full'
  /** fragment paths sent (fragment mode) */
  fragments?: string[]
  errorsBefore: number
  errorsAfter: number
  outcome: 'fixed' | 'partial' | 'no_change' | 'failed'
  note?: string
}
export interface RepairDiagnostics {
  initialErrors: ErrorView[]
  attempts: RepairAttempt[]
  /** every automatic, meaning-preserving normalisation applied before validation */
  normalizations: string[]
}

export type RunOutput = { intent: Intent; correlationId: string; steps: StepEvent[]; usage: UsageTotals; route?: Route } & (
  | { kind: 'answer'; text: string; references: string[]; source: 'deterministic' | 'model'; candidates?: string[] }
  | { kind: 'proposal'; proposal: Proposal; outcome: ValidationOutcome; valid: boolean; deterministic: boolean; stoppedBecause?: string; diagnostics?: RepairDiagnostics }
  | { kind: 'clarify'; questions: Question[]; assumptions: string[] }
  | { kind: 'restore'; text: string; target?: RestoreTarget }
  /** a calculation, rule or dashboard built from plain words: a validated DRAFT, nothing saved or run yet */
  | { kind: 'configure'; draft: ConfigDraft }
  | { kind: 'configure_invalid'; errors: { path: string; message: string }[]; source: 'ai' | 'parser'; attempts: number }
  | { kind: 'error'; code: string; message: string; retryable: boolean }
)

const zeroUsage = (): UsageTotals => ({ inputTokens: 0, outputTokens: 0, cachedTokens: 0, calls: 0, latencyMs: 0, source: 'gemini' })

const isFailure = (r: GenerateResponse | TransportFailure): r is TransportFailure => !('calls' in r)

const compactErrors = (errors: Issue[]) => errors.slice(0, 15).map((e) => ({ stage: e.stage, code: e.code, path: e.path, message: e.message.replace(/expected one of .*$/i, 'not an allowed value').slice(0, 200), allowed: e.allowed, received: e.received, suggested: e.suggested, repair: e.repair.slice(0, 160) }))
const errorViews = (errors: Issue[]): ErrorView[] => errors.slice(0, 30).map((e) => ({ code: e.code, stage: e.stage, path: e.path, message: e.message.slice(0, 240), allowed: e.allowed, received: e.received, suggested: e.suggested, userActionRequired: e.userActionRequired }))

/** Fix up the fields the application knows better than the model (ids/revision/versions) and stamp provenance. */
function stamp(kind: 'blueprint' | 'patch', raw: unknown, base: { projectId: string; revision: string }, gen: { model: string; provider: string; correlationId: string; intent: string; at: string }) {
  if (!raw || typeof raw !== 'object') return raw
  const o = structuredClone(raw) as Record<string, any>
  if (kind === 'patch') {
    o.schemaVersion = SCHEMA_VERSION
    o.expected_revision = base.revision
  } else if (o.meta && typeof o.meta === 'object') {
    o.meta.projectId = base.projectId
    o.meta.revisionId = base.revision
    o.meta.schemaVersion = SCHEMA_VERSION
    o.meta.blueprintVersion = BLUEPRINT_VERSION
    o.meta.generation = { model: gen.model.slice(0, 80), provider: gen.provider, generatedAt: gen.at, correlationId: gen.correlationId, intent: gen.intent }
  }
  return o
}

export async function runGenius(input: RunInput, deps: RunDeps): Promise<RunOutput> {
  const now = deps.now ?? (() => new Date())
  const steps: StepEvent[] = []
  const usage = zeroUsage()
  const correlationId = newCorrelationId(now().getTime())
  const ws = input.workspaceId
  const tenant = getTenantId()
  const actor = currentActor()
  const g = () => useGeniusStore.getState()

  const emit = (e: StepEvent) => {
    const i = steps.findIndex((s) => s.id === e.id)
    if (i >= 0) steps[i] = e
    else steps.push(e)
    input.onStep?.(e)
  }
  const timed = async <T>(id: StepId, label: string, fn: () => T | Promise<T>, detail?: (r: T) => string): Promise<T> => {
    const t0 = performance.now()
    emit({ id, label, status: 'running' })
    try {
      const r = await fn()
      emit({ id, label, status: 'done', detail: detail?.(r), ms: Math.round(performance.now() - t0) })
      return r
    } catch (e) {
      emit({ id, label, status: 'error', detail: e instanceof Error ? e.message : 'failed', ms: Math.round(performance.now() - t0) })
      throw e
    }
  }
  const base = { correlationId, steps, usage }
  const add = (r: GenerateResponse) => {
    usage.inputTokens += r.usage.inputTokens
    usage.outputTokens += r.usage.outputTokens
    usage.cachedTokens += r.usage.cachedTokens
    usage.calls += r.calls
    usage.latencyMs += r.latencyMs
    usage.source = r.provider
  }

  const request = input.request.trim()
  // a long request is never cut down silently: it is either sent whole or refused with a clear reason
  if (request.length > MAX_REQUEST_CHARS) return { correlationId, steps, usage, intent: 'new_build', kind: 'error', code: 'request_too_long', message: `That request is ${request.length.toLocaleString()} characters; the limit is ${MAX_REQUEST_CHARS.toLocaleString()}. Nothing was cut off or changed. Split it into two or three smaller requests (for example one per group of modules).`, retryable: false }
  if (input.answers?.length) g().recordAnswers(ws, input.answers)

  // ---- 1. understand (deterministic) ------------------------------------------------------------------------------
  let cfg: ConfigModel = readConfig(ws)
  const names = [...cfg.modules.map((m) => m.name), ...cfg.workflows.map((w) => w.name)]
  const parsed = await timed('understand', 'Understanding your request', () => parseIntent(request, { hasModules: cfg.modules.some((m) => !m.system), knownNames: names, hasVersions: g().versions.some((v) => v.workspaceId === ws && !v.undone) }), (p) => `${p.intent.replace(/_/g, ' ')}${p.readOnly ? ' (read-only: nothing will change)' : ''}`)
  const intent = parsed.intent
  g().rememberRequest(ws, request, intent)
  g().audit1({ actor: actor.userId, workspaceId: ws, action: 'ai_request', target: correlationId, detail: `intent=${intent} confidence=${parsed.confidence}`, correlationId })

  // ---- 2. deterministic handlers (no model) -------------------------------------------------------------------------
  if (intent === 'explain_calculation' || intent === 'simulate_workflow') {
    const a = await timed('handle', intent === 'explain_calculation' ? 'Reading the stored formula' : 'Running a dry run (nothing is changed)', () => (intent === 'explain_calculation' ? explainCalculation(cfg, actor, request) : simulateWorkflow(cfg, actor, request, now())))
    return { ...base, intent, kind: 'answer', text: a.text, references: a.references, source: 'deterministic', candidates: a.candidates, route: { tier: 'none', reason: 'answered from the stored configuration' } }
  }
  if (intent === 'restore_version') {
    const r = await timed('handle', 'Finding the version to restore', () => restoreTarget(ws, request))
    return { ...base, intent, kind: 'restore', text: r.text, target: r.target, route: { tier: 'none', reason: 'restore never needs a model' } }
  }
  if (intent === 'configure') {
    const route: Route = { tier: 'strong', reason: 'a calculation, rule or dashboard must match your real fields exactly' }
    const out = await runConfigure(
      { workspaceId: ws, request, answers: g().memoryOf(ws).answers, correlationId, projectId: projectIdFor(tenant, ws), revision: revisionOf(cfg), currency: currencyOfConfig(cfg) },
      { transport: deps.transport, now, signal: input.signal },
      { step: (id, label, fn, detail) => timed(id, label, fn, detail), usage: add },
    )
    if (out.kind === 'draft') return { ...base, intent, route, kind: 'configure', draft: out.draft }
    if (out.kind === 'clarify') {
      emit({ id: 'clarify', label: 'Checking what I need to ask', status: 'done', detail: `${out.questions.length} question${out.questions.length === 1 ? '' : 's'}` })
      g().setPending(ws, out.questions)
      return { ...base, intent, route, kind: 'clarify', questions: out.questions, assumptions: out.assumptions }
    }
    if (out.kind === 'invalid') return { ...base, intent, route, kind: 'configure_invalid', errors: out.errors, source: out.source, attempts: out.attempts }
    return { ...base, intent, route, kind: 'answer', text: out.message, references: [], source: 'deterministic' }
  }
  if (intent === 'modify' || intent === 'delete_or_deactivate') {
    const simple = simplePatch(cfg, actor, request)
    if (simple) {
      const { proposal, outcome } = await timed('handle', 'Building the change directly (no AI needed)', () => submitProposal(ws, { kind: 'patch', raw: simple.patch, request, intent, summary: simple.summary, assumptions: simple.assumptions, correlationId }))
      emit({ id: 'validate', label: 'Checking the change', status: outcome.report.ok ? 'done' : 'error', detail: outcome.report.ok ? 'all checks passed' : `${outcome.report.errors.length} problem(s)` })
      return { ...base, intent, kind: 'proposal', proposal, outcome, valid: outcome.report.ok, deterministic: true, route: { tier: 'none', reason: 'a simple, exact change handled by code' } }
    }
  }

  // ---- 3. clarify (only what is costly to guess) ----------------------------------------------------------------------
  const memory = g().memoryOf(ws)
  const answers = memory.answers
  const answered = new Set(answers.map((a) => a.questionId))
  const knownCurrency = currencyFromAnswers(answers) ?? currencyOfConfig(cfg)
  const pre = preflight({ request: `${request} ${answers.map((a) => a.answer).join(' ')}`, intent, answeredIds: answered, knownCurrency })
  if (intent !== 'question' && pre.questions.length) {
    emit({ id: 'clarify', label: 'Checking what I need to ask', status: 'done', detail: `${pre.questions.length} question${pre.questions.length === 1 ? '' : 's'}` })
    g().setPending(ws, pre.questions)
    return { ...base, intent, kind: 'clarify', questions: pre.questions, assumptions: pre.assumptions }
  }
  emit({ id: 'clarify', label: 'Checking what I need to ask', status: 'skipped', detail: 'nothing costly is unclear' })

  // ---- 4. context (retrieval) -----------------------------------------------------------------------------------------
  const operation = intent === 'new_build' ? 'new_build' : intent === 'question' ? 'question' : intent === 'repair' ? 'repair' : 'modify'
  const kind = intent === 'new_build' ? 'blueprint' : intent === 'question' ? 'answer' : 'patch'
  const revision = revisionOf(cfg)
  const projectId = projectIdFor(tenant, ws)
  const { project, context } = await timed(
    'context',
    'Gathering the parts of your CRM this touches',
    () => {
      const project = summarizeProject(tenant, cfg, actor, memory, g().versions)
      if (intent === 'new_build' && !cfg.modules.some((m) => !m.system)) return { project: undefined, context: undefined, fitted: undefined as undefined | ReturnType<typeof fitContext> }
      const ctx = retrieveContext(cfg, actor, request, intent)
      const fit = fitContext(ctx, CONTEXT_BUDGET_TOKENS)
      return { project, context: fit.context, fitted: fit }
    },
    (r) => (r.context ? `${r.context.modules.length} module${r.context.modules.length === 1 ? '' : 's'} in detail, ~${estimateTokens(JSON.stringify(r.context))} tokens` : 'empty workspace: nothing to include'),
  )

  // ---- 5. route -------------------------------------------------------------------------------------------------------
  const route = await timed('route', 'Choosing how to do this', () => routeModel({ intent, request, confidence: parsed.confidence, selectedModules: context?.modules.filter((m) => m.detail === 'full').length ?? 0 }), (r) => `${r.tier === 'strong' ? 'large model' : 'fast model'}: ${r.reason}`)
  if (route.tier === 'none') return { ...base, intent, route, kind: 'error', code: 'unroutable', message: 'This request could not be handled.', retryable: false }

  const recordData = kind === 'answer' ? recordDigest(cfg.modules, readRecords(ws), useUserStore.getState().users, actor, context?.modules.filter((m) => m.detail === 'full').map((m) => m.id)) : undefined
  // a request that already lists what to build is detailed enough: design it with safe defaults instead of interrogating the user
  const detailed = intent === 'new_build' && request.split(/\s+/).filter((w) => w.length > 2).length >= 8
  const hint = detailed || answers.length > 0 ? '\n\n(The request is detailed enough. Do not ask questions: choose safe defaults, list them in "assumptions", and return status "ok" with the full design.)' : ''
  const variable = (extra: Partial<GenerateWire['variable']> = {}): GenerateWire['variable'] => ({
    request: request + hint,
    project,
    context,
    data: kind === 'answer' ? recordData : undefined,
    memory: { ...memoryForPrompt(memory), requirements: [...(memory.requirements ?? []), ...answersAsRequirements(answers)].slice(-16) },
    meta: { projectId, revisionId: revision, currency: knownCurrency, locale: 'en-GB', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', today: now().toISOString().slice(0, 10) },
    ...extra,
  })
  const cancelled: TransportFailure = { ok: false, code: 'unavailable', message: 'Cancelled. Nothing was changed.', retryable: true }
  /** Cancelling stops waiting and discards whatever comes back; the server may still finish the call, but nothing is applied. */
  const call = (mode: 'generate' | 'repair', extra: Partial<GenerateWire['variable']> = {}, fragment = false): Promise<GenerateResponse | TransportFailure> => {
    if (input.signal?.aborted) return Promise.resolve(cancelled)
    // a fragment repair carries ONLY the invalid fragments and a short reminder of the request: no project, context, memory or data
    const v: GenerateWire['variable'] = fragment ? { request: `Fix the invalid fragments. The user originally asked: ${request.slice(0, 600)}`, ...extra } : variable(extra)
    const req = deps.transport({ workspaceId: ws, correlationId, operation: mode === 'repair' ? 'repair' : operation, kind: fragment ? 'fragment' : kind, mode, tier: fragment ? 'fast' : mode === 'repair' ? 'strong' : route.tier === 'none' ? 'fast' : route.tier, variable: v })
    const sig = input.signal
    if (!sig) return req
    return Promise.race([req, new Promise<TransportFailure>((resolve) => sig.addEventListener('abort', () => resolve(cancelled), { once: true }))])
  }

  const fail = (code: string, message: string, retryable: boolean): RunOutput => ({ ...base, intent, route, kind: 'error', code, message, retryable })

  // ---- 6. design (server round trip) ------------------------------------------------------------------------------------
  let first: GenerateResponse | TransportFailure
  try {
    first = await timed('design', 'Designing with AI', () => call('generate'), (r) => (isFailure(r) ? r.code : r.ok ? `${r.models.join(', ')} · ${r.usage.inputTokens + r.usage.outputTokens} tokens (${r.usage.cachedTokens} cached)` : r.code))
  } catch {
    return fail('network', 'Could not reach the AI service. Your CRM is unchanged.', true)
  }
  if (isFailure(first)) return fail(first.code, first.message, first.retryable)
  add(first)
  if (!first.ok) return fail(first.code, first.message, first.retryable)
  const models = [...first.models]
  let env = first.envelope

  // The model asked only things the user already answered (or that have safe defaults): tell it to stop asking and design,
  // up to twice, instead of failing the whole request.
  for (let nudge = 0; nudge < 2 && env.status === 'needs_clarification' && (!filterQuestions(env.questions ?? [], answers, []).length || answers.length > 0 || detailed); nudge++) {
    const again = await timed('design', 'Designing with AI (answers already given)', () => call('generate', { request: `${request}\n\nDo NOT ask any questions. The answers in MEMORY are final. Use safe defaults for anything unclear, list them in "assumptions", and return status "ok" with the full ${kind === 'blueprint' ? 'blueprint' : kind === 'patch' ? 'patch' : 'answer'}.` }), (r) => (isFailure(r) ? r.code : r.ok ? 'received a design' : r.code))
    if (isFailure(again)) return fail(again.code, again.message, again.retryable)
    add(again)
    if (!again.ok) return fail(again.code, again.message, again.retryable)
    again.models.forEach((m) => !models.includes(m) && models.push(m))
    env = again.envelope
  }

  if (env.status === 'needs_clarification') {
    const qs = filterQuestions(env.questions ?? [], answers, []).slice(0, 2)
    if (!qs.length) return fail('clarification_loop', 'The AI wanted to ask something you already answered. Please add that detail to your request and try again.', false)
    g().setPending(ws, qs)
    return { ...base, intent, route, kind: 'clarify', questions: qs, assumptions: env.assumptions ?? [] }
  }
  if (kind === 'answer') {
    // read-only: only the answer text is ever used, whatever else the model returned
    return { ...base, intent, route, kind: 'answer', text: env.answer ?? '', references: env.references ?? [], source: 'model' }
  }

  // ---- 7. validate + bounded repair ------------------------------------------------------------------------------------
  const asOf = now().toISOString()
  const stampIt = (raw: unknown, model: string) => stamp(kind as 'blueprint' | 'patch', raw, { projectId, revision }, { model, provider: first && !isFailure(first) ? first.provider : 'gemini', correlationId, intent, at: asOf })
  const validate = (raw: unknown): ValidationOutcome => {
    const ctx = validationContext(ws, { now: asOf })
    return kind === 'blueprint' ? validateBlueprint(raw, ctx) : validatePatch(raw, ctx)
  }

  const normalizations: string[] = [...(env.normalizations ?? [])]
  const sanitize = (v: unknown) => {
    const notes: string[] = []
    const out = sanitizeModelOutput(kind as 'blueprint' | 'patch', v, notes)
    for (const n of notes) if (!normalizations.includes(n) && normalizations.length < 80) normalizations.push(n)
    return out
  }
  let raw = stampIt(sanitize(kind === 'blueprint' ? env.blueprint : env.patch), models[models.length - 1])
  let outcome = await timed('validate', 'Checking the design (6 stages)', () => validate(raw), (o) => (o.report.ok ? 'all checks passed' : `${o.report.errors.length} problem(s) to fix`))
  const seenSignatures = new Set<string>()
  const seenRaw = new Set<string>([hash53(JSON.stringify(raw))])
  let repairs = 0
  let fragmentTries = 0
  let fragmentsUseful = true
  let stoppedBecause: string | undefined
  const diagnostics: RepairDiagnostics = { initialErrors: outcome.report.ok ? [] : errorViews(outcome.report.errors), attempts: [], normalizations }
  const settle = (attempt: RepairAttempt) => {
    diagnostics.attempts.push(attempt)
    // mark which first-seen errors are gone now
    const still = new Set(outcome.report.errors.map((e) => `${e.code}@${e.path}`))
    for (const e of diagnostics.initialErrors) e.fixed = !still.has(`${e.code}@${e.path}`)
  }

  while (!outcome.report.ok && (repairs < MAX_REPAIR_ATTEMPTS || (fragmentsUseful && fragmentTries < MAX_FRAGMENT_ATTEMPTS))) {
    const sig = errorSignature(outcome.report.errors)
    if (seenSignatures.has(sig)) {
      stoppedBecause = 'The same problems came back after a repair, so I stopped instead of looping.'
      break
    }
    seenSignatures.add(sig)
    const before = outcome.report.errors.length

    // ---- 7a. fragment repair: only the invalid parts go to the model, never the whole design --------------------------
    const plan = fragmentsUseful && fragmentTries < MAX_FRAGMENT_ATTEMPTS ? planFragments(raw, outcome.report.errors) : null
    if (plan?.ok) {
      fragmentTries += 1
      const frs: FragmentRequest[] = plan.fragments
      let res: GenerateResponse | TransportFailure
      try {
        res = await timed('repair', `Fixing ${frs.length} invalid part${frs.length === 1 ? '' : 's'} only (fragment ${fragmentTries} of ${MAX_FRAGMENT_ATTEMPTS})`, () => call('repair', { fragments: frs }, true), (r) => (isFailure(r) ? r.code : r.ok ? 'received corrected parts' : r.code))
      } catch {
        stoppedBecause = 'The AI service could not be reached for the repair.'
        diagnostics.attempts.push({ n: diagnostics.attempts.length + 1, mode: 'fragment', fragments: frs.map((f) => f.path), errorsBefore: before, errorsAfter: before, outcome: 'failed', note: 'network failure' })
        break
      }
      if (isFailure(res) || !res.ok) {
        stoppedBecause = res.message
        diagnostics.attempts.push({ n: diagnostics.attempts.length + 1, mode: 'fragment', fragments: frs.map((f) => f.path), errorsBefore: before, errorsAfter: before, outcome: 'failed', note: res.message })
        break
      }
      add(res)
      res.models.forEach((m) => !models.includes(m) && models.push(m))
      const applied = res.envelope.status === 'ok' ? applyFragments(raw, frs, res.envelope.fragments ?? []) : { next: raw, applied: [] as string[], rejected: [{ path: '*', why: 'the model could not fix these without more information' }] }
      if (applied.applied.length) {
        raw = stampIt(sanitize(applied.next), models[models.length - 1])
        const h = hash53(JSON.stringify(raw))
        if (!seenRaw.has(h)) {
          seenRaw.add(h)
          outcome = await timed('validate', 'Checking the design again', () => validate(raw), (o) => (o.report.ok ? 'all checks passed' : `${o.report.errors.length} problem(s) remain`))
        }
      }
      const after = outcome.report.ok ? 0 : outcome.report.errors.length
      const noChange = !applied.applied.length || errorSignature(outcome.report.errors) === sig
      settle({ n: diagnostics.attempts.length + 1, mode: 'fragment', fragments: frs.map((f) => f.path), errorsBefore: before, errorsAfter: after, outcome: after === 0 ? 'fixed' : noChange ? 'no_change' : 'partial', note: applied.rejected.length ? applied.rejected.map((r) => `${r.path}: ${r.why}`).join('; ').slice(0, 300) : undefined })
      if (noChange) {
        // the targeted repair did not help: allow the full-design repair next, and do not treat the unchanged errors as a loop yet
        fragmentsUseful = false
        seenSignatures.delete(sig)
      }
      continue
    }
    if (repairs >= MAX_REPAIR_ATTEMPTS) break

    // ---- 7b. full repair (bounded): the previous output and its errors go back to the model -------------------------------
    repairs += 1
    const errs = compactErrors(outcome.report.errors)
    let res: GenerateResponse | TransportFailure
    try {
      res = await timed('repair', `Fixing ${errs.length} problem${errs.length === 1 ? '' : 's'} (attempt ${repairs} of ${MAX_REPAIR_ATTEMPTS})`, () => call('repair', { previous: raw, errors: errs }), (r) => (isFailure(r) ? r.code : r.ok ? 'received a corrected design' : r.code))
    } catch {
      stoppedBecause = 'The AI service could not be reached for the repair.'
      break
    }
    if (isFailure(res) || !res.ok) {
      stoppedBecause = isFailure(res) ? res.message : res.message
      diagnostics.attempts.push({ n: diagnostics.attempts.length + 1, mode: 'full', errorsBefore: before, errorsAfter: before, outcome: 'failed', note: stoppedBecause })
      break
    }
    add(res)
    res.models.forEach((m) => !models.includes(m) && models.push(m))
    const next = res.envelope.status === 'ok' ? (kind === 'blueprint' ? res.envelope.blueprint : res.envelope.patch) : undefined
    if (!next) {
      stoppedBecause = 'The AI answered the repair with a question instead of a fix.'
      diagnostics.attempts.push({ n: diagnostics.attempts.length + 1, mode: 'full', errorsBefore: before, errorsAfter: before, outcome: 'failed', note: stoppedBecause })
      break
    }
    raw = stampIt(sanitize(next), models[models.length - 1])
    const h = hash53(JSON.stringify(raw))
    if (seenRaw.has(h)) {
      stoppedBecause = 'The repair returned exactly the same output, so I stopped instead of looping.'
      diagnostics.attempts.push({ n: diagnostics.attempts.length + 1, mode: 'full', errorsBefore: before, errorsAfter: before, outcome: 'no_change' })
      break
    }
    seenRaw.add(h)
    outcome = await timed('validate', 'Checking the design again', () => validate(raw), (o) => (o.report.ok ? 'all checks passed' : `${o.report.errors.length} problem(s) remain`))
    const after = outcome.report.ok ? 0 : outcome.report.errors.length
    settle({ n: diagnostics.attempts.length + 1, mode: 'full', errorsBefore: before, errorsAfter: after, outcome: after === 0 ? 'fixed' : 'partial' })
  }
  if (!outcome.report.ok && !stoppedBecause) stoppedBecause = `Still ${outcome.report.errors.length} problem(s) after ${diagnostics.attempts.length} repair attempt${diagnostics.attempts.length === 1 ? '' : 's'}. Nothing was applied.`

  // ---- 8. prepare the proposal (a draft nobody has accepted yet) ---------------------------------------------------------
  const { proposal } = await timed(
    'prepare',
    'Preparing the preview',
    () =>
      submitProposal(
        ws,
        { kind: kind === 'blueprint' ? 'build' : 'patch', raw, request, intent, summary: env.summary, assumptions: [...(env.assumptions ?? []), ...pre.assumptions, ...(normalizations.length ? [`${normalizations.length} value${normalizations.length === 1 ? ' was' : 's were'} normalised automatically before checking (see Repairs and normalisation).`] : [])], questions: [], correlationId, usage, models, repairAttempts: diagnostics.attempts.length },
        { now: asOf },
      ),
    (r) => `${r.proposal.changes.length} change${r.proposal.changes.length === 1 ? '' : 's'}`,
  )
  if (kind === 'blueprint' && outcome.blueprint) g().patchMemory(ws, (m) => ({ ...m, domain: outcome.blueprint!.meta.domain, assumptions: [...m.assumptions, ...(env.assumptions ?? [])].slice(-20) }))
  return { ...base, intent, route, kind: 'proposal', proposal, outcome, valid: outcome.report.ok, deterministic: false, stoppedBecause, diagnostics }
}