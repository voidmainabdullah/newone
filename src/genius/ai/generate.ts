import { z } from 'zod'
import { Blueprint, Patch, Question } from '../blueprint/schema'
import { QuerySpec } from '../search/spec'
import { buildPrompt, userMessage, type PromptMode, type ResponseKind, type VariableData } from './ai-core'
import { logAi, estimateTokens } from './observability'
import { MAX_TOKENS, TEMPERATURE, TIMEOUT_MS, type ModelSet } from './models'
import { LLMError, type LLMProvider, type Operation, type StructuredMode, type Usage } from './provider'
import { pruneToSchema, stripNulls } from './strictSchema'
import { repairRelationships } from './relation-logic'
import { modelIdFor, type Tier } from './model-router'

/**
 * Server-side call orchestration for ONE model step (generate or repair). It owns the failure policy that is about the
 * model's transport/format, not about CRM validity:
 *   truncated   -> escalate fast->strong once, then one retry with a larger budget
 *   empty / malformed / wrong envelope -> one re-ask (escalating to the strong model)
 *   everything else (auth, 400, refusal, filter, exhausted 429/5xx) -> stop, report, nothing is changed
 * CRM validity (the six validation stages) is the client's job: the client holds the configuration, so validation and
 * the bounded repair loop live there. A hard cap of 3 model calls per step bounds cost whatever happens.
 */
export const MAX_CALLS_PER_STEP = 5

const EnvelopeBase = z.object({
  status: z.string(),
  summary: z.string().max(2000).optional(),
  assumptions: z.array(z.string().max(400)).max(20).optional(),
  questions: z.array(Question).max(4).optional(),
  blueprint: z.unknown().optional(),
  patch: z.unknown().optional(),
  answer: z.string().max(4000).optional(),
  references: z.array(z.string().max(100)).max(30).optional(),
  queryspec: z.unknown().optional(),
  /** a calculation, rule or dashboard (engine schema). Checked by the engine on the client, never trusted. */
  config: z.unknown().optional(),
  fragments: z.array(z.strictObject({ path: z.string().min(1).max(200), valueJson: z.string().min(1).max(60_000) })).max(30).optional(),
  /** every automatic, meaning-preserving normalisation applied to this answer (shown to the user, never hidden) */
  normalizations: z.array(z.string().max(300)).max(60).optional(),
})
export type Envelope = z.infer<typeof EnvelopeBase>

/** Documented wording for the dashboard period enum. Returns undefined when the wording is not one of them. */
export function canonicalDateRange(raw: string): 'all' | '7d' | '30d' | '90d' | 'year' | undefined {
  const v = raw.toLowerCase().replace(/[\s_\-.]/g, '')
  if (['all', '7d', '30d', '90d', 'year'].includes(v)) return v as never
  if (/^(alltime|lifetime|total|everything|allperiods|noperiod)$/.test(v)) return 'all'
  if (/^(last|past|previous)?7days?$/.test(v) || v === '1week' || v === 'lastweek' || v === 'pastweek') return '7d'
  if (/^(last|past|previous)?30days?$/.test(v) || v === 'lastmonth' || v === 'pastmonth' || v === '1month') return '30d'
  if (/^(last|past|previous)?90days?$/.test(v) || v === 'lastquarter' || v === 'pastquarter' || v === '3months' || v === 'last3months') return '90d'
  if (/^(thisyear|year|ytd|yeartodate|last365days?|past365days?|12months|last12months|pastyear|lastyear)$/.test(v)) return 'year'
  return undefined
}

/** Models in plain JSON mode sometimes nest lists under a module that belong beside it. Move them back; validation still runs on the result. */
function normalizeBlueprint(json: unknown, notes: string[] = []): unknown {
  const bp = (json as { blueprint?: Record<string, unknown> } | null)?.blueprint
  if (!bp || typeof bp !== 'object' || !Array.isArray(bp.modules)) return json
  // common slips in plain JSON mode: synonyms for enum values the schema does not allow
  const TYPE_SYNONYMS: Record<string, string> = {
    text: 'shortText', string: 'shortText', short_text: 'shortText', singlelinetext: 'shortText', textarea: 'longText', long_text: 'longText', multilinetext: 'longText', notes: 'longText',
    integer: 'number', int: 'number', float: 'number', decimal: 'number', numeric: 'number', money: 'currency', price: 'currency', amount: 'currency',
    boolean: 'yesNo', bool: 'yesNo', checkbox: 'yesNo', select: 'dropdown', enum: 'dropdown', choice: 'dropdown', singleselect: 'dropdown', multi_select: 'multiSelect', multiselect: 'multiSelect',
    url: 'website', link: 'website', telephone: 'phone', tel: 'phone', mail: 'email', timestamp: 'datetime', date_time: 'datetime', percent: 'percentage', location: 'address', person: 'user', assignee: 'user',
  }
  const POLICY_SYNONYMS: Record<string, string> = { no_action: 'restrict', noaction: 'restrict', none: 'restrict', block: 'restrict', prevent: 'restrict', 'set null': 'set_null', setnull: 'set_null', nullify: 'set_null', delete: 'cascade', 'set_null ': 'set_null' }
  for (const m of bp.modules as Record<string, any>[]) {
    if (!m || !Array.isArray(m.fields)) continue
    for (const f of m.fields)
      if (f && typeof f.type === 'string') {
        const mapped = TYPE_SYNONYMS[f.type.toLowerCase().replace(/[\s-]/g, '')] ?? TYPE_SYNONYMS[f.type.toLowerCase()]
        if (mapped && mapped !== f.type) notes.push(`field type "${f.type}" on ${String(m.id)}.${String(f.id)} normalised to "${mapped}"`)
        f.type = mapped ?? f.type
      }
  }
  if (Array.isArray(bp.relationships)) for (const r of bp.relationships as Record<string, any>[]) if (r && typeof r.deletePolicy === 'string') {
    const mapped = POLICY_SYNONYMS[r.deletePolicy.toLowerCase()] ?? r.deletePolicy.toLowerCase()
    if (mapped !== r.deletePolicy) notes.push(`deletePolicy "${r.deletePolicy}" normalised to "${mapped}"`)
    r.deletePolicy = mapped
  }
  // module ids the model mistyped in references (tenancies vs tenancy): point them at the module that was meant
  const ids = (bp.modules as Record<string, any>[]).map((m) => m?.id).filter((x): x is string => typeof x === 'string')
  const key = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(ies)$/, 'y').replace(/s$/, '')
  const byKey = new Map(ids.map((i) => [key(i), i]))
  const fixRef = (o: any, prop: string) => {
    if (o && typeof o[prop] === 'string' && !ids.includes(o[prop])) o[prop] = byKey.get(key(o[prop])) ?? o[prop]
  }
  for (const list of ['relationships', 'forms', 'layouts', 'views', 'pipelines', 'workflows', 'formulas', 'permissions'] as const)
    if (Array.isArray(bp[list])) for (const it of bp[list] as any[]) for (const prop of ['moduleId', 'sourceModuleId', 'targetModuleId']) fixRef(it, prop)
  for (const d of (Array.isArray(bp.dashboards) ? bp.dashboards : []) as any[]) for (const c of (Array.isArray(d?.components) ? d.components : []) as any[]) fixRef(c, 'moduleId')
  for (const m of bp.modules as Record<string, any>[]) {
    if (!m || !Array.isArray(m.fields)) continue
    const fids = new Set(m.fields.map((f: any) => f?.id))
    if (m.displayFieldId && !fids.has(m.displayFieldId)) m.displayFieldId = m.fields.find((f: any) => f?.type === 'shortText')?.id
    if (Array.isArray(m.searchFieldIds)) m.searchFieldIds = m.searchFieldIds.filter((x: string) => fids.has(x))
    fixRef(m, 'parentModuleId')
  }
  const hoist = ['relationships', 'pipelines', 'workflows', 'forms', 'views', 'formulas'] as const
  for (const key of hoist) {
    const moved: unknown[] = []
    bp.modules = (bp.modules as Record<string, unknown>[]).map((m) => {
      if (m && typeof m === 'object' && Array.isArray(m[key])) {
        const { [key]: items, ...rest } = m
        for (const it of items as Record<string, unknown>[]) {
          if (!it || typeof it !== 'object') continue
          const owner = typeof m.id === 'string' ? m.id : undefined
          moved.push(key === 'relationships' ? (it.sourceModuleId ? it : { ...it, sourceModuleId: owner }) : it.moduleId ? it : { ...it, moduleId: owner })
        }
        return rest
      }
      return m
    })
    if (moved.length) bp[key] = [...(Array.isArray(bp[key]) ? (bp[key] as unknown[]) : []), ...moved]
  }
  if (!Array.isArray(bp.layouts)) bp.layouts = []
  const relNotes = repairRelationships(bp)
  if (relNotes.length) {
    const holder = json as { assumptions?: unknown }
    holder.assumptions = [...(Array.isArray(holder.assumptions) ? holder.assumptions : []), ...relNotes].slice(0, 20)
  }
  // dashboard period: ONLY documented, unambiguous wording is mapped. Anything else is left exactly as written so the
  // validator reports SCHEMA_INVALID_VALUE with the allowed values; it is never silently replaced by "all".
  ;(bp.dashboards as Record<string, any>[] | undefined)?.forEach?.((d, di) =>
    (Array.isArray(d?.components) ? d.components : []).forEach((c: Record<string, any>, ci: number) => {
      if (!c || typeof c !== 'object') return
      const where = `dashboards.${di}.components.${ci}`
      if (c.dateRange === undefined || c.dateRange === null) {
        c.dateRange = 'all'
        notes.push(`${where}.dateRange: missing, set to the default \"all\" (no period filter)`)
      } else if (typeof c.dateRange === 'string' || typeof c.dateRange === 'number') {
        const mapped = canonicalDateRange(typeof c.dateRange === 'number' ? `${c.dateRange}d` : c.dateRange)
        if (mapped && mapped !== c.dateRange) {
          notes.push(`${where}.dateRange: \"${String(c.dateRange).slice(0, 40)}\" normalised to \"${mapped}\"`)
          c.dateRange = mapped
        }
      }
      if (c.filters === undefined || c.filters === null) {
        c.filters = []
        notes.push(`${where}.filters: missing, set to [] (no filters)`)
      }
    }),
  )
  return json
}

/** Same clean-up the server applies, usable on the client for a design that came back from an older server build. Mutates and returns `value`. */
export function sanitizeModelOutput(kind: 'blueprint' | 'patch', value: unknown, notes?: string[]): unknown {
  if (!value || typeof value !== 'object') return value
  if (kind === 'blueprint') {
    const wrapped = { blueprint: value }
    normalizeBlueprint(wrapped, notes)
    pruneToSchema(wrapped.blueprint, Blueprint, notes)
    return wrapped.blueprint
  }
  pruneToSchema(value, Patch, notes)
  return value
}

const clip = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : v)

/** Make the envelope fit its limits when the model is merely over-long, loose with ids, or inconsistent about status. */
function tidyEnvelope(kind: ResponseKind, c: any): void {
  if (!c || typeof c !== 'object') return
  c.summary = clip(c.summary, 2000)
  c.answer = clip(c.answer, 4000)
  if (Array.isArray(c.assumptions)) c.assumptions = c.assumptions.filter((x: unknown) => typeof x === 'string').map((x: string) => x.slice(0, 400)).slice(0, 20)
  else if (typeof c.assumptions === 'string') c.assumptions = [c.assumptions.slice(0, 400)]
  if (Array.isArray(c.references)) c.references = c.references.map((x: unknown) => clip(String(x), 100)).slice(0, 30)
  if (Array.isArray(c.questions)) {
    c.questions = c.questions
      .map((q: any, i: number) => {
        if (typeof q === 'string') q = { question: q }
        if (!q || typeof q !== 'object' || typeof q.question !== 'string' || q.question.trim().length < 3) return null
        const id = typeof q.id === 'string' && /^[a-z][a-z0-9_]{0,63}$/i.test(q.id) ? q.id : `q_${i + 1}_${q.question.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30)}`
        const out: any = { id, question: q.question.slice(0, 300), why: typeof q.why === 'string' ? q.why.slice(0, 200) : 'needed to design this correctly', options: Array.isArray(q.options) ? q.options.filter((o: unknown) => typeof o === 'string').map((o: string) => o.slice(0, 80)).slice(0, 6) : [] }
        if (typeof q.safeDefault === 'string') out.safeDefault = q.safeDefault.slice(0, 120)
        return out
      })
      .filter(Boolean)
      .slice(0, 4)
  }
  const st = typeof c.status === 'string' ? c.status.toLowerCase().replace(/[\s-]/g, '_') : ''
  const hasBody = kind === 'blueprint' ? !!c.blueprint : kind === 'patch' ? !!c.patch : kind === 'queryspec' ? !!c.queryspec : kind === 'config' ? !!c.config : typeof c.answer === 'string' && c.answer.length > 0
  if (/^(success|succeeded|done|complete|completed|ok|created|designed)$/.test(st)) c.status = 'ok'
  else if (/^(needs_clarification|clarify|clarification|question|questions|need_info|needs_info)$/.test(st)) c.status = 'needs_clarification'
  else if (!st || /^(cannot_answer|unable|unknown|error|partial)$/.test(st)) c.status = hasBody ? 'ok' : kind === 'answer' && c.answer ? 'ok' : c.questions?.length ? 'needs_clarification' : c.status ?? 'ok'
  if (c.status === 'needs_clarification' && !c.questions?.length && hasBody) c.status = 'ok'
  if (c.status === 'ok' && kind === 'answer' && !c.answer && c.summary) c.answer = c.summary
}

const invalid = (detail: string) => new LLMError('schema_invalid', detail, { userMessage: `The AI answer did not follow the required format (${detail.slice(0, 90)}). Please try again. Your CRM is unchanged.` })

export function parseEnvelope(kind: ResponseKind, json: unknown): Envelope {
  const notes: string[] = []
  const cleaned: any = stripNulls(kind === 'blueprint' ? normalizeBlueprint(json, notes) : json)
  if (cleaned && typeof cleaned === 'object') {
    tidyEnvelope(kind, cleaned)
    if (kind === 'blueprint') pruneToSchema(cleaned.blueprint, Blueprint, notes)
    if (kind === 'patch') pruneToSchema(cleaned.patch, Patch, notes)
    if (kind === 'queryspec') pruneToSchema(cleaned.queryspec, QuerySpec, notes)
    if (notes.length) cleaned.normalizations = notes.slice(0, 60)
  }
  const r = EnvelopeBase.safeParse(cleaned)
  if (!r.success) throw invalid(`envelope: ${r.error.issues[0]?.path.join('.') ?? ''} ${r.error.issues[0]?.message ?? ''}`.trim())
  const e = r.data
  if (kind === 'fragment') {
    if (e.status === 'cannot_fix') return e
    if (e.status !== 'ok' || !e.fragments?.length) throw invalid('fragments missing')
    return e
  }
  if (kind === 'answer') {
    if (e.status === 'ok' && !e.answer) throw invalid('answer missing')
    return e
  }
  if (kind === 'queryspec') {
    if (e.status === 'ok' && !e.queryspec) throw invalid('queryspec missing')
    return e
  }
  if (kind === 'config') {
    if (e.status === 'cannot_answer') return e
    if (e.status === 'needs_clarification' && !e.questions?.length) throw invalid('needs_clarification without questions')
    if (e.status === 'ok' && !e.config) throw invalid('config missing')
    if (e.status !== 'ok' && e.status !== 'needs_clarification') throw invalid(`unknown status "${e.status.slice(0, 30)}"`)
    return e
  }
  if (e.status === 'needs_clarification') {
    if (!e.questions?.length) throw invalid('needs_clarification without questions')
    return e
  }
  if (e.status !== 'ok') throw invalid(`unknown status "${e.status.slice(0, 30)}"`)
  if (kind === 'blueprint' && !e.blueprint) throw invalid('blueprint missing')
  if (kind === 'patch' && !e.patch) throw invalid('patch missing')
  return e
}

export interface GenerateParams {
  tenantId: string
  workspaceId: string
  correlationId: string
  operation: Operation
  kind: ResponseKind
  mode: PromptMode
  tier: Exclude<Tier, 'none'>
  variable: VariableData
}

export interface StepStats {
  calls: number
  attempts: number
  latencyMs: number
  usage: Usage
  models: string[]
  structuredMode?: StructuredMode
  escalated: boolean
}

export type GenerateOutcome = ({ ok: true; envelope: Envelope } & StepStats) | ({ ok: false; code: LLMError['code']; message: string; retryable: boolean } & StepStats)

const zero = (): Usage => ({ inputTokens: 0, outputTokens: 0, cachedTokens: 0 })

/**
 * Providers on small plans cap tokens per request or per minute (GENIUS_INPUT_TOKEN_BUDGET). When the prompt would not
 * leave room for an answer, shed the least useful parts of the variable data, in order, until it fits.
 * The static system message is never touched (it is the cached prefix).
 */
export function fitVariable(v: VariableData, systemTokens: number, budget: number): VariableData {
  const cur = structuredClone(v) as VariableData & { project?: any; context?: any; memory?: any }
  const fits = () => systemTokens + estimateTokens(userMessage(cur)) <= budget
  const steps: ((x: typeof cur) => void)[] = [
    (x) => x.project && (x.project.recentChanges = []),
    (x) => x.memory && (x.memory = { ...x.memory, assumptions: [], answers: (x.memory.answers ?? []).slice(-3), requirements: (x.memory.requirements ?? []).slice(-4) }),
    (x) => x.project && (x.project = { ...x.project, workflows: [], dashboards: [], roles: [] }),
    (x) => x.context && ((x.context.dashboards = []), (x.context.views = []), (x.context.forms = [])),
    (x) => x.context && (x.context.outline = []),
    (x) => x.context?.modules?.forEach((m: any) => m.detail === 'compact' && m.fields?.forEach((f: any) => delete f.options)),
    (x) => x.context && (x.context.workflows = (x.context.workflows ?? []).slice(0, 3)),
    (x) => x.context && (x.context.dependents = (x.context.dependents ?? []).slice(0, 10)),
    (x) => x.context?.modules && (x.context.modules = x.context.modules.filter((m: any) => m.detail === 'full').concat(x.context.modules.filter((m: any) => m.detail !== 'full').map((m: any) => ({ ...m, fields: m.fields?.slice(0, 6) })))),
    (x) => x.project && (x.project = { ...x.project, modules: (x.project.modules ?? []).map((m: any) => ({ id: m.id, name: m.name, fields: m.fields })) }),
    (x) => x.memory && (x.memory = undefined),
    (x) => x.context?.modules && (x.context.modules = x.context.modules.filter((m: any) => m.detail === 'full').slice(0, 2)),
    (x) => x.data && Array.isArray(x.data) && (x.data = x.data.map((d: any) => ({ ...d, newest: (d.newest ?? []).slice(0, 2) }))),
    (x) => x.project && (x.project = undefined),
    (x) => x.data && Array.isArray(x.data) && (x.data = x.data.map((d: any) => ({ ...d, newest: [] }))),
    (x) => Array.isArray(x.errors) && (x.errors = x.errors.slice(0, 6)),
    (x) => x.previous !== undefined && JSON.stringify(x.previous).length > 6000 && (x.previous = JSON.stringify(x.previous).slice(0, 6000)),
  ]
  for (const step of steps) {
    if (fits()) break
    step(cur)
  }
  return cur
}

export async function runGenerate(deps: { provider: LLMProvider; models: ModelSet; /** extra model ids tried in order when a model's daily quota is spent (GENIUS_MODEL_FALLBACKS) */ fallbackModels?: string[]; /** provider tokens-per-minute cap per request (GENIUS_TPM_LIMIT) */ tpmLimit?: number; /** multiplies the per-operation timeouts (GENIUS_TIMEOUT_SCALE) */ timeoutScale?: number }, p: GenerateParams): Promise<GenerateOutcome> {
  const tpm = deps.tpmLimit ?? 120_000
  const systemTokens = estimateTokens(buildPrompt(p.kind, p.mode, { request: '' }).system)
  // keep at least ~2,000 tokens free for the answer inside the per-request cap
  const prompt = buildPrompt(p.kind, p.mode, fitVariable(p.variable, systemTokens, Math.max(2500, tpm - 2200)))
  const stats: StepStats = { calls: 0, attempts: 0, latencyMs: 0, usage: zero(), models: [], escalated: false }
  let tier = p.tier
  let maxTokens = MAX_TOKENS[p.operation]
  let reasks = 0
  let triedFallback = false
  let overrideModel: string | undefined
  const fallbacks = [...(deps.fallbackModels ?? [])]
  let enlarged = false
  const staticTokens = estimateTokens(prompt.system)
  const variableTokens = estimateTokens(prompt.user)

  for (let call = 0; call < MAX_CALLS_PER_STEP; call++) {
    const model = overrideModel ?? modelIdFor(tier, deps.models)
    const caps = tier === 'fast' ? deps.models.fast : deps.models.strong
    maxTokens = Math.min(maxTokens, caps.maxOutputTokens, Math.max(1500, tpm - Math.ceil((staticTokens + variableTokens) * 0.95) - 100))
    stats.calls += 1
    if (!stats.models.includes(model)) stats.models.push(model)
    try {
      const res = await deps.provider.generate({
        operation: p.operation,
        model,
        system: prompt.system,
        user: prompt.user,
        schemaName: prompt.schemaName,
        jsonSchema: prompt.jsonSchema,
        maxTokens,
        temperature: TEMPERATURE,
        timeoutMs: Math.round(TIMEOUT_MS[p.operation] * (deps.timeoutScale ?? 1)),
        correlationId: p.correlationId,
      })
      stats.attempts += res.attempts
      stats.latencyMs += res.latencyMs
      stats.usage = { inputTokens: stats.usage.inputTokens + res.usage.inputTokens, outputTokens: stats.usage.outputTokens + res.usage.outputTokens, cachedTokens: stats.usage.cachedTokens + res.usage.cachedTokens }
      stats.structuredMode = res.structuredMode
      const envelope = parseEnvelope(p.kind, res.json)
      logAi({ correlationId: p.correlationId, tenantId: p.tenantId, operation: p.operation, step: p.mode, model, ok: true, ...res.usage, latencyMs: res.latencyMs, attempts: res.attempts, structuredMode: res.structuredMode, staticPrefixTokens: staticTokens, variableTokens })
      return { ok: true, envelope, ...stats }
    } catch (e) {
      const err = e instanceof LLMError ? e : new LLMError('server_error', 'unexpected failure')
      logAi({ correlationId: p.correlationId, tenantId: p.tenantId, operation: p.operation, step: p.mode, model, ok: false, code: err.code, staticPrefixTokens: staticTokens, variableTokens })
      // A model that cannot serve the request right now (daily quota spent, overloaded after all retries, id unknown) is
      // replaced by the next free model: strong -> fast -> the listed fallbacks. A 400 is a problem with the request itself
      // and is never re-sent to other models.
      const dailyQuota = err.code === 'rate_limited' && /per day|daily|local budget: rpd|\bRPD\b/i.test(err.message)
      const overloaded = err.code === 'server_error' || (err.code === 'rate_limited' && err.retryable)
      if (dailyQuota || overloaded || (err.code === 'invalid_request' && err.status === 404)) {
        if (tier === 'strong' && !overrideModel && !triedFallback) {
          triedFallback = true
          tier = 'fast'
          continue
        }
        const next = fallbacks.shift()
        if (next) {
          overrideModel = next
          tier = 'strong'
          maxTokens = MAX_TOKENS[p.operation]
          continue
        }
      }
      if (err.code === 'truncated') {
        if (tier === 'fast') {
          tier = 'strong'
          stats.escalated = true
          continue
        }
        if (!enlarged) {
          enlarged = true
          maxTokens = Math.ceil(maxTokens * 1.5)
          continue
        }
      }
      if ((err.code === 'empty' || err.code === 'malformed_json' || err.code === 'schema_invalid') && reasks < 1) {
        reasks += 1
        if (tier === 'fast') {
          tier = 'strong'
          stats.escalated = true
        }
        continue
      }
      return { ok: false, code: err.code, message: err.userMessage, retryable: err.retryable || err.code === 'truncated', ...stats }
    }
  }
  return { ok: false, code: 'schema_invalid', message: 'The AI answer could not be used after several tries. Your CRM is unchanged.', retryable: true, ...stats }
}
