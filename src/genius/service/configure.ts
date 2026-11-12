import type { ID, Module, Role } from '#/types'
import { parseNl, type NlDraft } from '#/engine/nl'
import { previewConfig, type Preview } from '#/engine/editing'
import { makeEnv } from '#/engine/resolve'
import { typeToKind, type CalculationBody, type ConditionalRuleBody, type ConfigKind, type DashboardBody } from '#/engine/schema'
import { currentRole, saveAndRun, saveConfig, validationEnvFor } from '#/engine/service'
import { validateConfig, type Issue } from '#/engine/validate'
import { computeEngineWidget } from '#/engine/widgets'
import { useModuleStore } from '#/stores/moduleStore'
import { useRecordStore } from '#/stores/recordStore'
import { useSettingsStore } from '#/stores/settingsStore'
import { uid } from '#/utils/id'
import type { Question } from '../blueprint/schema'
import { filterQuestions } from '../ai/clarification'
import type { GenerateResponse, GenerateWire, Transport, TransportFailure } from '../ai/wire'
import type { QuestionAnswer } from '../state/types'

/**
 * "Configure": plain words -> a calculation, a rule or a dashboard.
 *
 *   find the real schema -> build a config (the model when it is reachable, else the deterministic parser in engine/nl.ts)
 *   -> validate (zod + validate.ts: fields exist, operators fit the type, numeric ops on numbers, no cycles)
 *   -> at most ONE repair round (the errors go back to the model) -> preview on real records.
 *
 * The result is only ever a DRAFT. Nothing here saves or runs anything: model output is never trusted, and the only way to
 * persist a draft is `confirmDraft`, which goes through the engine's guarded save (validated again, permission checked).
 */

export type ConfigureKind = 'calculations' | 'conditional_rules' | 'dashboards'
export type DraftBody = CalculationBody | ConditionalRuleBody | DashboardBody
export const CONFIGURE_KINDS: ConfigureKind[] = ['calculations', 'conditional_rules', 'dashboards']

export interface ConfigDraft {
  id: string
  workspaceId: ID
  request: string
  kind: ConfigureKind
  body: DraftBody
  /** module id (a dashboard that spans modules has none) */
  entity?: string
  moduleName?: string
  summary: string
  assumptions: string[]
  source: 'ai' | 'parser'
  /** the model's first answer failed validation and the repair round fixed it */
  repaired: boolean
  /** calculations and rules: up to 5 real records, before -> after (computed by the engine, nothing written) */
  preview: Preview | null
  /** dashboards: how many widgets computed a value from the real records */
  widgets?: { total: number; computed: number }
  /** the signed-in role may confirm this kind of change */
  permission: { allowed: boolean; message?: string }
  status: 'draft' | 'saved' | 'cancelled'
  savedId?: string
  createdAt: string
}

export type ConfigureOutcome =
  | { kind: 'draft'; draft: ConfigDraft }
  | { kind: 'clarify'; questions: Question[]; assumptions: string[] }
  | { kind: 'invalid'; errors: Issue[]; source: 'ai' | 'parser'; attempts: number }
  | { kind: 'unsupported'; message: string }

export type ConfigureStep = 'find' | 'build' | 'validate' | 'repair' | 'preview'

export interface ConfigureHooks {
  step: <T>(id: ConfigureStep, label: string, fn: () => T | Promise<T>, detail?: (r: T) => string) => Promise<T>
  /** account for a model call (tokens, latency) */
  usage?: (r: GenerateResponse) => void
}

export interface ConfigureInput {
  workspaceId: ID
  request: string
  answers: QuestionAnswer[]
  correlationId: string
  projectId: string
  revision: string
  currency?: string
}

export interface ConfigureDeps {
  transport: Transport
  now?: () => Date
  signal?: AbortSignal
}

const isFailure = (r: GenerateResponse | TransportFailure): r is TransportFailure => !('calls' in r)
const SENTENCE = (s: string) => s.replace(/\s+/g, ' ').trim()

// ---- the real schema, as the model sees it ---------------------------------------------------------------------------

export const modulesOf = (ws: ID): Module[] => useModuleStore.getState().modules.filter((m) => m.workspaceId === ws && !m.archived && !m.system)

/** Only what exists: modules, fields, types and option labels. No records, no ids of anything else. */
export function schemaContext(ws: ID, today: string) {
  return {
    today,
    modules: modulesOf(ws).map((m) => ({
      id: m.id,
      name: m.name,
      singular: m.singularName,
      fields: m.fields
        .filter((f) => !f.id.startsWith('__'))
        .map((f) => ({ name: f.name || f.id, label: f.label, type: f.type, ...(f.options?.length ? { options: f.options.map((o) => o.label) } : {}), ...(f.calculated ? { calculated: true } : {}), ...(f.relation ? { links_to: f.relation.moduleId } : {}) })),
    })),
  }
}

// ---- checking a candidate ----------------------------------------------------------------------------------------------

/** keys the model must not decide (identity, ownership, sharing): dropped, then the engine fills them in */
const OWNED_KEYS = ['id', 'version', 'createdAt', 'updatedAt', 'ownerId', 'workspaceId', 'scope', 'userId', 'baseId', 'isDefault', 'autoManaged']

function cleanCandidate(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const o = { ...(raw as Record<string, unknown>) }
  for (const k of OWNED_KEYS) delete o[k]
  return o
}

/** Parse + validate a candidate against the real schema. Role is NOT checked here (that is a separate, explained step). */
export function checkCandidate(ws: ID, raw: unknown): { ok: true; kind: ConfigureKind; body: DraftBody } | { ok: false; errors: Issue[] } {
  const cleaned = cleanCandidate(raw)
  const type = (cleaned as { type?: unknown } | null)?.type
  const kind = typeToKind(type)
  if (!kind || !CONFIGURE_KINDS.includes(kind as ConfigureKind)) return { ok: false, errors: [{ path: 'type', message: 'A sentence can only create a calculation, a conditional_rule or a dashboard' }] }
  const res = validateConfig(cleaned, validationEnvFor(ws, { role: null }), kind)
  if (!res.ok || !res.body) return { ok: false, errors: res.errors.length ? res.errors : [{ path: '(root)', message: 'The configuration is not valid' }] }
  return { ok: true, kind: kind as ConfigureKind, body: res.body as DraftBody }
}

/** The role is checked on its own so the person is told why, instead of the draft silently disappearing. */
export function permissionFor(ws: ID, kind: ConfigureKind, body: DraftBody, role: Role | null | undefined = undefined): { allowed: boolean; message?: string } {
  const r = role === null ? undefined : (role ?? currentRole())
  if (!r) return { allowed: true }
  const res = validateConfig(body, validationEnvFor(ws, { role: r }), kind)
  const denied = res.errors.find((e) => e.path === '(permission)')
  return denied ? { allowed: false, message: denied.message } : { allowed: true }
}

/** "Fees · paid amount, total amount": what the request resolved to, read back from the finished config. */
export function resolvedNames(ws: ID, body: DraftBody): string {
  const modules = modulesOf(ws)
  const mods = new Set<string>()
  const fields = new Set<string>()
  const walk = (node: unknown, entity?: string) => {
    if (Array.isArray(node)) return node.forEach((n) => walk(n, entity))
    if (!node || typeof node !== 'object') return
    const o = node as Record<string, unknown>
    const ent = typeof o.entity === 'string' ? o.entity : entity
    const m = ent ? modules.find((x) => x.id === ent || x.name === ent) : undefined
    if (typeof o.entity === 'string' && m) mods.add(m.name)
    for (const k of ['field', 'output_field', 'groupBy', 'dateField']) {
      const v = o[k]
      if (typeof v === 'string' && m) {
        const f = m.fields.find((x) => x.name === v || x.id === v)
        fields.add(f?.label ?? v)
      }
    }
    for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v, ent)
  }
  walk(body)
  return [[...mods].join(', '), [...fields].join(', ')].filter(Boolean).join(' · ') || 'nothing yet'
}

// ---- the model ---------------------------------------------------------------------------------------------------------

type ModelResult =
  | { kind: 'config'; raw: unknown; summary?: string; assumptions: string[] }
  | { kind: 'clarify'; questions: Question[]; assumptions: string[] }
  | { kind: 'unavailable'; why: string }

async function askModel(input: ConfigureInput, deps: ConfigureDeps, hooks: ConfigureHooks, mode: 'generate' | 'repair', extra: { previous?: unknown; errors?: Issue[] } = {}): Promise<ModelResult> {
  if (deps.signal?.aborted) return { kind: 'unavailable', why: 'cancelled' }
  const today = (deps.now?.() ?? new Date()).toISOString().slice(0, 10)
  const wire: GenerateWire = {
    workspaceId: input.workspaceId,
    correlationId: input.correlationId,
    operation: 'modify',
    kind: 'config',
    mode,
    tier: 'strong',
    variable: {
      request: input.request,
      context: schemaContext(input.workspaceId, today),
      memory: input.answers.length ? { answers: input.answers.map((a) => ({ question: a.question, answer: a.answer })) } : undefined,
      meta: { projectId: input.projectId.slice(0, 80), revisionId: input.revision.slice(0, 80), currency: input.currency, locale: 'en-GB', today },
      ...(extra.previous !== undefined ? { previous: extra.previous } : {}),
      ...(extra.errors ? { errors: extra.errors.slice(0, 12).map((e) => ({ path: e.path, message: e.message.slice(0, 240) })) } : {}),
    },
  }
  let res: GenerateResponse | TransportFailure
  try {
    res = await deps.transport(wire)
  } catch {
    return { kind: 'unavailable', why: 'network' }
  }
  if (isFailure(res)) return { kind: 'unavailable', why: res.code }
  hooks.usage?.(res)
  if (!res.ok) return { kind: 'unavailable', why: res.code }
  const env = res.envelope
  const assumptions = env.assumptions ?? []
  if (env.status === 'needs_clarification') return { kind: 'clarify', questions: (env.questions ?? []).slice(0, 2), assumptions }
  if (env.status === 'ok' && env.config) return { kind: 'config', raw: env.config, summary: env.summary, assumptions }
  return { kind: 'unavailable', why: env.status }
}

// ---- finishing a draft --------------------------------------------------------------------------------------------------

async function finish(ws: ID, request: string, kind: ConfigureKind, body: DraftBody, meta: { summary: string; assumptions: string[]; source: 'ai' | 'parser'; repaired: boolean }, deps: ConfigureDeps, hooks: ConfigureHooks): Promise<ConfigDraft> {
  const modules = modulesOf(ws)
  const entity = kind === 'dashboards' ? undefined : (body as CalculationBody | ConditionalRuleBody).entity
  const module = entity ? modules.find((m) => m.id === entity || m.name === entity) : undefined
  const now = deps.now?.() ?? new Date()
  const permission = permissionFor(ws, kind, body)
  let preview: Preview | null = null
  let widgets: ConfigDraft['widgets']
  await hooks.step(
    'preview',
    'Computing a preview',
    () => {
      if (kind === 'dashboards') {
        const env = makeEnv(modules, useRecordStore.getState().records.filter((r) => r.workspaceId === ws), now)
        const list = (body as DashboardBody).widgets
        const computed = list.filter((w) => {
          try {
            return computeEngineWidget(w, env).kind !== 'error'
          } catch {
            return false
          }
        }).length
        widgets = { total: list.length, computed }
      } else preview = previewConfig(ws, body as CalculationBody | ConditionalRuleBody, { limit: 5, now })
    },
    () => (kind === 'dashboards' ? `${widgets?.computed ?? 0} of ${widgets?.total ?? 0} widgets computed from your records` : preview?.ok ? (preview.rows.length ? `${preview.rows.length} real record${preview.rows.length === 1 ? '' : 's'}` : (preview.note ?? 'no records yet')) : (preview?.error ?? 'could not preview')),
  )
  return { id: uid('cfg'), workspaceId: ws, request, kind, body, entity: module?.id ?? entity, moduleName: module?.name, summary: meta.summary, assumptions: meta.assumptions, source: meta.source, repaired: meta.repaired, preview, widgets, permission, status: 'draft', createdAt: now.toISOString() }
}

const toQuestion = (q: { id: string; question: string; why: string; options: string[] }): Question => ({ id: q.id, question: SENT(q.question, 300), why: SENT(q.why, 200), options: q.options.slice(0, 6).map((o) => o.slice(0, 80)) })
const SENT = (s: string, n: number) => SENTENCE(s).slice(0, n)

function describeFailure(why: string): string {
  return why === 'auth_required' ? 'not signed in' : why === 'cancelled' ? 'cancelled' : `AI unavailable (${why})`
}

/**
 * The whole configure pipeline. `hooks.step` reports each piece of real work (the Studio chat shows them as it goes).
 */
export async function runConfigure(input: ConfigureInput, deps: ConfigureDeps, hooks: ConfigureHooks): Promise<ConfigureOutcome> {
  const ws = input.workspaceId
  const answerMap = Object.fromEntries(input.answers.map((a) => [a.questionId, a.answer]))

  // 1. find: the real modules and fields, and what the deterministic parser makes of the request
  const parsed = await hooks.step(
    'find',
    'Finding the module and fields',
    () => parseNl(input.request, modulesOf(ws), { answers: answerMap }),
    (r) => (r.kind === 'draft' ? resolvedNames(ws, r.body) : r.kind === 'clarify' ? 'one name needs your decision' : 'matching with AI'),
  )
  const parserDraft: NlDraft | undefined = parsed.kind === 'draft' ? parsed : undefined

  // 2. build: the model first (strict schema, real schema as its only context); the parser when it is not reachable
  const model = await hooks.step('build', 'Building the configuration', () => askModel(input, deps, hooks, 'generate'), (r) => (r.kind === 'unavailable' ? `${describeFailure(r.why)}: using the built-in parser` : r.kind === 'clarify' ? 'needs one answer' : 'AI drafted a configuration'))

  if (model.kind === 'clarify') {
    const qs = filterQuestions(model.questions, input.answers, [])
    if (qs.length) return { kind: 'clarify', questions: qs, assumptions: model.assumptions }
  }

  let source: 'ai' | 'parser' = 'ai'
  let candidate: unknown = model.kind === 'config' ? model.raw : undefined
  let summary = model.kind === 'config' ? (model.summary ?? '') : ''
  let assumptions = model.kind === 'config' ? model.assumptions : []

  if (candidate === undefined) {
    source = 'parser'
    if (parsed.kind === 'clarify') return { kind: 'clarify', questions: [toQuestion(parsed)], assumptions: [] }
    if (!parserDraft) return { kind: 'unsupported', message: parsed.kind === 'none' ? `${parsed.reason} Try one of the phrasings in the examples, or build it from the module's Calculations / Rules tab.` : 'I could not turn that into a configuration.' }
    candidate = parserDraft.body
    summary = parserDraft.summary
    assumptions = parserDraft.assumptions
  }

  // 3. validate: zod + the semantic checks. A bad config is never shown as a draft, saved or run.
  let checked = await hooks.step('validate', 'Validating against your real fields', () => checkCandidate(ws, candidate), (r) => (r.ok ? 'every field, operator and type checks out' : `${r.errors.length} problem${r.errors.length === 1 ? '' : 's'}: ${r.errors[0].path} ${r.errors[0].message}`.slice(0, 160)))
  let repaired = false
  let attempts = 0

  // 4. one repair round: only for model output (the parser's output is already built from the real names)
  if (!checked.ok && source === 'ai') {
    attempts = 1
    const errors = checked.errors
    const fix = await hooks.step('repair', 'Fixing the problems (1 attempt)', () => askModel(input, deps, hooks, 'repair', { previous: candidate, errors }), (r) => (r.kind === 'config' ? 'received a corrected configuration' : 'no usable correction'))
    if (fix.kind === 'config') {
      candidate = fix.raw
      summary = fix.summary ?? summary
      assumptions = fix.assumptions.length ? fix.assumptions : assumptions
      checked = checkCandidate(ws, candidate)
      repaired = checked.ok
    }
    // still wrong: the built-in parser may understand the sentence even though the model did not
    if (!checked.ok && parserDraft) {
      const alt = checkCandidate(ws, parserDraft.body)
      if (alt.ok) {
        source = 'parser'
        candidate = parserDraft.body
        summary = parserDraft.summary
        assumptions = [...parserDraft.assumptions, 'The AI answer did not pass validation, so the built-in parser read your request instead.']
        checked = alt
        repaired = false
      }
    }
  }
  if (!checked.ok) return { kind: 'invalid', errors: checked.errors, source, attempts }

  const draft = await finish(ws, input.request, checked.kind, checked.body, { summary: summary || (parserDraft?.summary ?? 'A configuration built from your request.'), assumptions: [...new Set(assumptions)], source, repaired }, deps, hooks)
  return { kind: 'draft', draft }
}

// ---- confirm ---------------------------------------------------------------------------------------------------------------

export interface ConfirmResult {
  ok: boolean
  errors: Issue[]
  savedId?: string
  /** what ran: how many records were recalculated / changed (calculations and rules) */
  report?: { processed: number; written: number; errors: number }
  warnings: string[]
  createdFields: string[]
  /** where to look at it */
  link?: { label: string; to: string; tab?: 'calculations' | 'rules'; moduleId?: string; dashboardId?: string }
  message: string
}

/**
 * Save a confirmed draft through the engine's guarded save (validated again, permission checked, versioned, persisted),
 * run it (recalculate the affected records) and say where it lives. A dashboard is saved as the person's own.
 */
export async function confirmDraft(draft: ConfigDraft, opts: { role?: Role | null; userId?: string } = {}): Promise<ConfirmResult> {
  const ws = draft.workspaceId
  const userId = opts.userId ?? useSettingsStore.getState().settings.currentUserId ?? ''
  const fail = (errors: Issue[]): ConfirmResult => ({ ok: false, errors, warnings: [], createdFields: [], message: errors[0] ? `${errors[0].message}` : 'Nothing was saved.' })
  if (draft.status !== 'draft') return fail([{ path: '(root)', message: draft.status === 'saved' ? 'This was already saved.' : 'This draft was cancelled.' }])

  if (draft.kind === 'dashboards') {
    const body = { ...(draft.body as DashboardBody), scope: 'user' as const, userId }
    const res = saveConfig(ws, body, { expected: 'dashboards', role: opts.role, ownerId: userId })
    if (!res.ok || !res.item) return fail(res.errors)
    const name = (draft.body as DashboardBody).name
    return { ok: true, errors: [], savedId: res.item.id, warnings: res.warnings, createdFields: res.createdFields, link: { label: 'Open the dashboard', to: '/dashboards', dashboardId: res.item.id }, message: `Saved “${name}” as your dashboard with ${(draft.body as DashboardBody).widgets.length} widgets. The values are computed from your records and update as they change.` }
  }

  const body = draft.body as CalculationBody | ConditionalRuleBody
  const res = await saveAndRun(ws, body, { expected: draft.kind, role: opts.role, ownerId: userId })
  if (!res.ok || !res.item) return fail(res.errors)
  const moduleId = body.entity
  const m = modulesOf(ws).find((x) => x.id === moduleId || x.name === moduleId)
  const report = res.report ? { processed: res.report.processed, written: res.report.written, errors: res.report.errors.length } : undefined
  const what = draft.kind === 'calculations' ? 'calculation' : 'rule'
  const ran = report ? ` It ran on ${report.processed} record${report.processed === 1 ? '' : 's'} and updated ${report.written}${report.errors ? ` (${report.errors} could not be processed)` : ''}.` : ''
  return {
    ok: true,
    errors: [],
    savedId: res.item.id,
    report,
    warnings: res.warnings,
    createdFields: res.createdFields,
    link: { label: draft.kind === 'calculations' ? 'Open Calculations' : 'Open Rules', to: `/m/${m?.id ?? moduleId}`, tab: draft.kind === 'calculations' ? 'calculations' : 'rules', moduleId: m?.id ?? moduleId },
    message: `Saved the ${what}${draft.kind === 'calculations' && res.createdFields.length ? ` and created the field ${res.createdFields.join(', ')}` : ''}.${ran}`,
  }
}

export const kindLabel = (k: ConfigureKind): string => (k === 'calculations' ? 'Calculation' : k === 'conditional_rules' ? 'Rule' : 'Dashboard')
export const isConfigureKind = (k: ConfigKind | undefined): k is ConfigureKind => !!k && (CONFIGURE_KINDS as string[]).includes(k)
