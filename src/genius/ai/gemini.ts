import { defaultSleep, limitSchemaSize, parseJsonLoose, salvageJson } from './json-utils'
import { TEMPERATURE, TIMEOUT_MS, type ModelCaps, type ModelSet } from './models'
import { LLMError, type GenerateRequest, type GenerateResult, type LLMProvider, type StructuredMode, type Usage } from './provider'
import { QuotaTracker } from './quota'

/**
 * Google Gemini adapter (Developer API, `generateContent`). Server-side only: the key comes from the GEMINI_API_KEY
 * binding, is sent in the `x-goog-api-key` header, and never appears in a log, an error or a response.
 *
 * Structured output: `generationConfig.responseJsonSchema` (JSON Schema) with `responseMimeType: application/json`.
 * If the API rejects the schema (too complex, unsupported keyword) the adapter steps down ONCE to plain JSON mode; the
 * response contract is also in the system prompt, and the application validates the result either way. A valid JSON
 * answer is never treated as a correct CRM design.
 *
 * Failure policy (see classify()): 429 honours the retry hint and the local quota tracker; 5xx/network/timeout retry with
 * exponential backoff and jitter; 400/401/403/404 are never retried blindly; a MAX_TOKENS finish is reported as `truncated`.
 */
export const GEMINI_BASE = 'https://generativelanguage.googleapis.com'

export interface GeminiOptions {
  /** the secret. Read from the server binding GEMINI_API_KEY by the caller, never from client code. */
  apiKey: string | undefined
  models: ModelSet
  baseUrl?: string
  fetch?: typeof fetch
  quota?: QuotaTracker
  /** transient-failure retries (429, 5xx, network, timeout, empty) on top of the first attempt */
  maxRetries?: number
  baseDelayMs?: number
  maxDelayMs?: number
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

const SCHEMA_400 = /schema|constraint|too many states|nesting|response_?mime|json mode|unsupported (keyword|field)|Unknown name/i
const THINKING_400 = /thinking|thought/i

interface Part {
  text?: string
  thought?: boolean
}
interface GeminiResponse {
  candidates?: { finishReason?: string; content?: { parts?: Part[] } }[]
  promptFeedback?: { blockReason?: string }
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number; thoughtsTokenCount?: number }
}

export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini'
  readonly quota: QuotaTracker
  private readonly o: Required<Omit<GeminiOptions, 'apiKey' | 'fetch' | 'quota'>> & { apiKey?: string; fetch?: typeof fetch }

  constructor(o: GeminiOptions) {
    this.quota = o.quota ?? new QuotaTracker()
    this.o = { maxRetries: 4, baseDelayMs: 1000, maxDelayMs: 8000, sleep: defaultSleep, random: Math.random, ...o, baseUrl: o.baseUrl ?? GEMINI_BASE }
  }

  private caps(model: string): ModelCaps {
    const { fast, strong } = this.o.models
    if (model === strong.id) return strong
    if (model === fast.id) return fast
    return { ...strong, id: model, tier: 'strong' }
  }

  private backoff(retry: number, retryAfterMs?: number): number {
    const exp = Math.min(this.o.maxDelayMs, this.o.baseDelayMs * 2 ** retry)
    const jitter = exp * 0.25 * this.o.random()
    return Math.min(this.o.maxDelayMs * 3, Math.max(retryAfterMs ?? 0, exp + jitter))
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const key = this.o.apiKey
    if (!key) throw new LLMError('misconfigured', 'GEMINI_API_KEY is not set')
    const caps = this.caps(req.model)
    // a schema Gemini would refuse as a whole is NOT sent in a shrunken form: a model held to a hollow `blueprint: {object}`
    // answers with an empty one (seen live). Plain JSON mode with the contract in the prompt produced full designs.
    const fits = JSON.stringify(limitSchemaSize(req.jsonSchema)) === JSON.stringify(req.jsonSchema)
    const modes: StructuredMode[] = caps.strictJsonSchema && fits ? ['strict', 'json_object'] : ['json_object']
    let modeIx = 0
    let thinking = caps.thinkingLevel
    let attempts = 0
    let retries = 0
    const maxTokens = Math.min(req.maxTokens, caps.maxOutputTokens)
    const inputEstimate = Math.ceil((req.system.length + req.user.length) / 3.6)
    const started = Date.now()
    let waits = 0

    for (;;) {
      // local budget first: do not spend a request the quota says will fail
      const verdict = this.quota.check(req.model, inputEstimate)
      if (!verdict.ok) {
        if (verdict.daily) throw new LLMError('rate_limited', `local budget: ${verdict.reason}`, { userMessage: `The daily request budget for ${req.model} is used up. It resets at midnight Pacific time. Your CRM is unchanged.` })
        if (verdict.retryAfterMs > this.o.maxDelayMs) throw new LLMError('rate_limited', `local budget: ${verdict.reason}`, { retryable: true, retryAfterMs: verdict.retryAfterMs })
        if (++waits > 6) throw new LLMError('rate_limited', `local budget: ${verdict.reason}`, { retryable: true, retryAfterMs: verdict.retryAfterMs })
        await this.o.sleep(verdict.retryAfterMs)
        continue
      }
      attempts += 1
      const mode = modes[modeIx]
      this.quota.record(req.model, inputEstimate)
      try {
        const res = await this.once(req, key, mode, maxTokens, thinking)
        return { ...res, attempts, latencyMs: Date.now() - started, structuredMode: mode, model: req.model }
      } catch (e) {
        const err = e instanceof LLMError ? e : new LLMError('network', 'unexpected provider failure', { retryable: true })
        // the API refused part of our request: correct that part once, without spending the retry budget
        if (err.code === 'invalid_request' && err.status === 400) {
          if (thinking && THINKING_400.test(err.message)) {
            thinking = undefined
            continue
          }
          // Google's schema refusals are often just "invalid argument": while a schema is being sent, that is treated as a schema problem
          if ((SCHEMA_400.test(err.message) || (/invalid argument/i.test(err.message) && modes[modeIx] === 'strict')) && modeIx < modes.length - 1) {
            modeIx += 1
            continue
          }
        }
        if (err.retryable && retries < this.o.maxRetries) {
          await this.o.sleep(this.backoff(retries, err.retryAfterMs))
          retries += 1
          continue
        }
        // out of retries (or a non-retryable 429): stop sending to this model until the provider's hint has passed
        if (err.code === 'rate_limited' && !err.message.startsWith('local budget')) this.quota.cooldown(req.model, err.retryAfterMs ?? (err.retryable ? 15_000 : 3_600_000))
        throw err
      }
    }
  }

  private async once(req: GenerateRequest, key: string, mode: StructuredMode, maxTokens: number, thinking: ModelCaps['thinkingLevel']): Promise<Omit<GenerateResult, 'attempts' | 'latencyMs' | 'structuredMode' | 'model'>> {
    const generationConfig: Record<string, unknown> = {
      temperature: req.temperature ?? TEMPERATURE,
      maxOutputTokens: maxTokens,
      responseMimeType: 'application/json',
    }
    if (mode === 'strict') generationConfig.responseJsonSchema = req.jsonSchema
    if (thinking) generationConfig.thinkingConfig = { thinkingLevel: thinking }
    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: 'user', parts: [{ text: req.user }] }],
      generationConfig,
    }

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), req.timeoutMs ?? TIMEOUT_MS[req.operation])
    let res: Response
    try {
      res = await (this.o.fetch ?? fetch)(`${this.o.baseUrl}/v1beta/models/${encodeURIComponent(req.model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
    } catch (e) {
      const aborted = ctrl.signal.aborted || (e instanceof Error && e.name === 'AbortError')
      throw aborted ? new LLMError('timeout', 'request deadline exceeded', { retryable: true }) : new LLMError('network', 'network failure', { retryable: true })
    } finally {
      clearTimeout(timer)
    }

    if (!res.ok) throw await httpError(res)

    let payload: GeminiResponse
    try {
      payload = (await res.json()) as GeminiResponse
    } catch {
      throw new LLMError('server_error', 'provider returned a non-JSON body', { retryable: true, status: res.status })
    }
    const usage = toUsage(payload.usageMetadata)
    if (payload.promptFeedback?.blockReason) throw new LLMError('content_filter', `prompt blocked: ${payload.promptFeedback.blockReason}`)
    const cand = payload.candidates?.[0]
    if (!cand) throw new LLMError('empty', 'no candidates in response', { retryable: true })
    const finish = cand.finishReason ?? 'STOP'
    if (finish === 'MAX_TOKENS') throw new LLMError('truncated', 'output hit maxOutputTokens')
    if (finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT' || finish === 'BLOCKLIST' || finish === 'SPII' || finish === 'IMAGE_SAFETY') throw new LLMError('content_filter', `blocked: ${finish}`)
    if (finish === 'RECITATION') throw new LLMError('refusal', 'blocked: recitation')
    const text = (cand.content?.parts ?? [])
      .filter((p) => !p.thought)
      .map((p) => p.text ?? '')
      .join('')
      .trim()
    if (!text) throw new LLMError('empty', 'empty completion', { retryable: true })
    const json = parseJsonLoose(text) ?? salvageJson(text)
    if (json === undefined || json === null || typeof json !== 'object') throw new LLMError('malformed_json', 'completion is not a JSON object')
    return { json, usage, finishReason: finish.toLowerCase() }
  }
}

function toUsage(u: GeminiResponse['usageMetadata']): Usage {
  return { inputTokens: u?.promptTokenCount ?? 0, outputTokens: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0), cachedTokens: u?.cachedContentTokenCount ?? 0 }
}

/** Seconds from a Google duration such as "12s" or "0.5s". */
const secs = (v: unknown) => (typeof v === 'string' && /^[\d.]+s$/.test(v) ? Math.ceil(Number.parseFloat(v) * 1000) : undefined)

async function httpError(res: Response): Promise<LLMError> {
  let detail = ''
  let apiStatus = ''
  let retryAfterMs: number | undefined
  let daily = false
  let badKey = false
  try {
    const j = (await res.json()) as { error?: { message?: string; status?: string; details?: Record<string, unknown>[] } }
    detail = String(j?.error?.message ?? '').slice(0, 300)
    apiStatus = String(j?.error?.status ?? '')
    for (const d of j?.error?.details ?? []) {
      retryAfterMs ??= secs(d.retryDelay)
      if (/PerDay/i.test(JSON.stringify(d))) daily = true
      if (d.reason === 'API_KEY_INVALID') badKey = true
    }
  } catch {
    /* body is optional */
  }
  const status = res.status
  // Google reports a bad key as HTTP 400 INVALID_ARGUMENT with reason API_KEY_INVALID: that is an auth problem, not a bad request
  if (status === 400 && (/API key not valid|API_KEY_INVALID/i.test(detail) || badKey)) return new LLMError('auth', `HTTP 400 API_KEY_INVALID`, { status, userMessage: 'Google rejected the Gemini API key. Create a key in Google AI Studio (it starts with AIza), save it again as the GEMINI_API_KEY secret, and try again. Your CRM is unchanged.' })
  const rs = res.headers.get('retry-after')
  if (retryAfterMs === undefined && rs && Number.isFinite(Number(rs))) retryAfterMs = Number(rs) * 1000
  const msg = `HTTP ${status}${apiStatus ? ` ${apiStatus}` : ''}${detail ? `: ${detail}` : ''}`
  if (status === 429) {
    if (daily || /per day|daily/i.test(detail)) return new LLMError('rate_limited', `${msg} (daily quota)`, { status, userMessage: 'The daily Gemini quota for this model is used up. It resets at midnight Pacific time; try again later or switch to another model. Your CRM is unchanged.' })
    return new LLMError('rate_limited', msg, { retryable: true, status, retryAfterMs })
  }
  if (status === 401 || status === 403) return new LLMError('auth', msg, { status, userMessage: status === 401 ? 'The Gemini API key was rejected. Check the GEMINI_API_KEY secret. Your CRM is unchanged.' : 'The Gemini API key has no permission for this model or project. Your CRM is unchanged.' })
  if (status === 404) return new LLMError('invalid_request', msg, { status, userMessage: 'The configured Gemini model was not found. Check GENIUS_MODEL_FAST and GENIUS_MODEL_STRONG. Your CRM is unchanged.' })
  if (status === 408 || status === 504) return new LLMError('timeout', msg, { retryable: true, status })
  if (status >= 500) return new LLMError('server_error', msg, { retryable: true, status, retryAfterMs })
  if (status === 400 && /token count|too long|exceeds the maximum|input.*too large|request.*too large/i.test(detail)) return new LLMError('invalid_request', msg, { status, userMessage: 'That request and its context are too large for the model. Split it into smaller requests. Your CRM is unchanged.' })
  const shown = detail.replace(/\s+/g, ' ').trim().slice(0, 110)
  return new LLMError('invalid_request', msg, { status, userMessage: `The AI service could not process that request (HTTP ${status}${shown ? `: ${shown}` : ''}). Your CRM is unchanged.` })
}
