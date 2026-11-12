import { defaultSleep, parseJsonLoose, salvageJson } from './json-utils'
import { TEMPERATURE, TIMEOUT_MS } from './models'
import { LLMError, type GenerateRequest, type GenerateResult, type LLMProvider, type Usage } from './provider'

/**
 * DeepSeek adapter (OpenAI-compatible chat completions). OPTIONAL and OFF by default.
 *
 * DeepSeek's official pricing page lists pay-per-token prices only; it mentions a "granted balance" without an amount,
 * and the free chat app is NOT a free API. This adapter therefore exists but is never selected automatically:
 *   - it is never a fallback for Gemini (there is no automatic routing between providers at all);
 *   - `buildProvider` constructs it only when GENIUS_PROVIDER=deepseek AND DEEPSEEK_API_KEY is set AND
 *     DEEPSEEK_ALLOW_PAID_USAGE=true, i.e. a person has explicitly accepted that requests may be charged
 *     (or has confirmed a granted, no-cost balance in the DeepSeek console);
 *   - a 402 (insufficient balance) is reported and never retried.
 */
export const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions'
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-flash'

export interface DeepSeekOptions {
  apiKey: string | undefined
  /** must be true: the owner has authorised requests that may cost money, or confirmed a no-cost granted balance */
  allowPaidUsage: boolean
  model?: string
  endpoint?: string
  fetch?: typeof fetch
  maxRetries?: number
  baseDelayMs?: number
  sleep?: (ms: number) => Promise<void>
}

interface ChatResponse {
  choices?: { finish_reason?: string | null; message?: { content?: string | null } }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number }
}

export class DeepSeekProvider implements LLMProvider {
  readonly name = 'deepseek'
  constructor(private readonly o: DeepSeekOptions) {}

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    if (!this.o.allowPaidUsage) throw new LLMError('misconfigured', 'DeepSeek is disabled until DEEPSEEK_ALLOW_PAID_USAGE=true', { userMessage: 'DeepSeek is not enabled for this workspace. Your CRM is unchanged.' })
    if (!this.o.apiKey) throw new LLMError('misconfigured', 'DEEPSEEK_API_KEY is not set')
    const sleep = this.o.sleep ?? defaultSleep
    const started = Date.now()
    const max = this.o.maxRetries ?? 2
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await this.once(req)
        return { ...r, attempts: attempt, latencyMs: Date.now() - started, structuredMode: 'json_object', model: this.o.model ?? DEEPSEEK_DEFAULT_MODEL }
      } catch (e) {
        const err = e instanceof LLMError ? e : new LLMError('network', 'unexpected provider failure', { retryable: true })
        if (!err.retryable || attempt > max) throw err
        await sleep(Math.max(err.retryAfterMs ?? 0, (this.o.baseDelayMs ?? 1000) * 2 ** (attempt - 1)))
      }
    }
  }

  private async once(req: GenerateRequest): Promise<Omit<GenerateResult, 'attempts' | 'latencyMs' | 'structuredMode' | 'model'>> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), req.timeoutMs ?? TIMEOUT_MS[req.operation])
    let res: Response
    try {
      res = await (this.o.fetch ?? fetch)(this.o.endpoint ?? DEEPSEEK_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.o.apiKey}` },
        body: JSON.stringify({
          model: this.o.model ?? DEEPSEEK_DEFAULT_MODEL,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
          temperature: req.temperature ?? TEMPERATURE,
          max_tokens: req.maxTokens,
          response_format: { type: 'json_object' },
          stream: false,
        }),
        signal: ctrl.signal,
      })
    } catch (e) {
      const aborted = ctrl.signal.aborted || (e instanceof Error && e.name === 'AbortError')
      throw aborted ? new LLMError('timeout', 'request deadline exceeded', { retryable: true }) : new LLMError('network', 'network failure', { retryable: true })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) {
      const s = res.status
      if (s === 402) throw new LLMError('auth', 'HTTP 402', { status: s, userMessage: 'The DeepSeek balance is empty. Nothing was charged and your CRM is unchanged.' })
      if (s === 401 || s === 403) throw new LLMError('auth', `HTTP ${s}`, { status: s })
      if (s === 429) throw new LLMError('rate_limited', 'HTTP 429', { status: s, retryable: true })
      if (s >= 500) throw new LLMError('server_error', `HTTP ${s}`, { status: s, retryable: true })
      throw new LLMError('invalid_request', `HTTP ${s}`, { status: s })
    }
    const payload = (await res.json().catch(() => ({}))) as ChatResponse
    const choice = payload.choices?.[0]
    if (!choice) throw new LLMError('empty', 'no choices', { retryable: true })
    if (choice.finish_reason === 'length') throw new LLMError('truncated', 'completion hit max_tokens')
    if (choice.finish_reason === 'content_filter') throw new LLMError('content_filter', 'blocked')
    const text = (choice.message?.content ?? '').trim()
    if (!text) throw new LLMError('empty', 'empty completion', { retryable: true })
    const json = parseJsonLoose(text) ?? salvageJson(text)
    if (!json || typeof json !== 'object') throw new LLMError('malformed_json', 'completion is not a JSON object')
    const u: Usage = { inputTokens: payload.usage?.prompt_tokens ?? 0, outputTokens: payload.usage?.completion_tokens ?? 0, cachedTokens: payload.usage?.prompt_cache_hit_tokens ?? 0 }
    return { json, usage: u, finishReason: choice.finish_reason ?? 'stop' }
  }
}
