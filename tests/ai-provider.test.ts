import { describe, expect, it, vi } from 'vitest'
import { GeminiProvider, GEMINI_BASE } from '#/genius/ai/gemini'
import { parseJsonLoose } from '#/genius/ai/json-utils'
import { resolveModels } from '#/genius/ai/models'
import { QuotaTracker } from '#/genius/ai/quota'
import { LLMError, type GenerateRequest, type LLMProvider } from '#/genius/ai/provider'
import { runGenerate, parseEnvelope } from '#/genius/ai/generate'
import { setLogSink, type AiLogEvent } from '#/genius/ai/observability'

const KEY = 'AIzaSy_test_SECRET_KEY_do_not_leak_123456'
const models = resolveModels({})

const req = (over: Partial<GenerateRequest> = {}): GenerateRequest => ({
  operation: 'modify',
  model: models.fast.id,
  system: 'STATIC',
  user: 'VARIABLE',
  schemaName: 'genius_patch_response',
  jsonSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  maxTokens: 1000,
  correlationId: 'cor_test',
  ...over,
})

const ok = (content: unknown, extra: Record<string, unknown> = {}, finishReason = 'STOP') =>
  new Response(JSON.stringify({ candidates: [{ finishReason, content: { parts: [{ text: typeof content === 'string' ? content : JSON.stringify(content) }] } }], usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 60, thoughtsTokenCount: 20, cachedContentTokenCount: 1000 }, ...extra }), { status: 200 })
const fail = (status: number, message = 'nope', headers: Record<string, string> = {}, details: unknown[] = []) => new Response(JSON.stringify({ error: { code: status, message, status: status === 429 ? 'RESOURCE_EXHAUSTED' : 'INVALID_ARGUMENT', details } }), { status, headers })

function provider(responses: (Response | Error | ((init: RequestInit) => Promise<Response>))[], over: Partial<ConstructorParameters<typeof GeminiProvider>[0]> = {}) {
  const calls: { url: string; init: RequestInit; body: Record<string, any> }[] = []
  const sleeps: number[] = []
  let i = 0
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) })
    const next = responses[Math.min(i++, responses.length - 1)]
    if (next instanceof Error) throw next
    if (typeof next === 'function') return next(init)
    return next.clone()
  })
  const p = new GeminiProvider({ apiKey: KEY, models, fetch: fetchMock as unknown as typeof fetch, sleep: async (ms: number) => void sleeps.push(ms), random: () => 0, maxRetries: 2, baseDelayMs: 500, maxDelayMs: 8000, quota: new QuotaTracker({ rpm: 1000, tpm: 100_000_000, rpd: 100_000 }), ...over })
  return { p, calls, sleeps, fetchMock }
}

const code = async (p: Promise<unknown>) => {
  try {
    await p
    return 'no error'
  } catch (e) {
    return e instanceof LLMError ? e.code : `other:${String(e)}`
  }
}

describe('GeminiProvider: request shape', () => {
  it('posts to generateContent with the key in a header (never the URL), system instruction, JSON schema, token budget and usage', async () => {
    const { p, calls } = provider([ok({ status: 'ok' })])
    const r = await p.generate(req())
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${GEMINI_BASE}/v1beta/models/${models.fast.id}:generateContent`)
    expect(calls[0].url).not.toContain(KEY)
    expect((calls[0].init.headers as Record<string, string>)['x-goog-api-key']).toBe(KEY)
    const b = calls[0].body
    expect(b.systemInstruction.parts[0].text).toBe('STATIC')
    expect(b.contents).toEqual([{ role: 'user', parts: [{ text: 'VARIABLE' }] }])
    expect(b.generationConfig).toMatchObject({ responseMimeType: 'application/json', maxOutputTokens: 1000, thinkingConfig: { thinkingLevel: 'low' } })
    expect(b.generationConfig.responseJsonSchema).toEqual(req().jsonSchema)
    expect(b.generationConfig.temperature).toBeLessThanOrEqual(0.2)
    expect(JSON.stringify(b)).not.toContain(KEY)
    expect(r.usage).toEqual({ inputTokens: 1200, outputTokens: 80, cachedTokens: 1000 })
    expect(r.structuredMode).toBe('strict')
    expect(r.attempts).toBe(1)
  })

  it('uses plain JSON mode (no schema) for a model without verified structured-output support', async () => {
    const m = resolveModels({ GENIUS_MODEL_FAST: 'some-vendor/unknown-model' })
    const { p, calls } = provider([ok({ a: 1 })], { models: m })
    const r = await p.generate(req({ model: 'some-vendor/unknown-model' }))
    expect(calls[0].body.generationConfig.responseJsonSchema).toBeUndefined()
    expect(calls[0].body.generationConfig.responseMimeType).toBe('application/json')
    expect(calls[0].body.generationConfig.thinkingConfig).toBeUndefined()
    expect(r.structuredMode).toBe('json_object')
  })

  it('model ids come from the environment; the defaults are Gemini free-tier models', () => {
    expect(models.fast.id).toBe('gemini-3.5-flash-lite')
    expect(models.strong.id).toBe('gemini-3.8-flash')
    const m = resolveModels({ GENIUS_MODEL_FAST: 'gemini-3.6-flash', GENIUS_MODEL_STRONG: 'x/y', GENIUS_MODEL_STRONG_STRICT: 'true', GENIUS_MODEL_FAST_THINKING: 'off' })
    expect(m.fast).toMatchObject({ id: 'gemini-3.6-flash', thinkingLevel: undefined })
    expect(m.strong).toMatchObject({ id: 'x/y', strictJsonSchema: true, promptCaching: false })
    expect(resolveModels({ GENIUS_MODEL_FAST: 'bad id with spaces' }).fast.id).toBe('gemini-3.5-flash-lite')
  })

  it('the response contract is never embedded in the URL and thought parts are ignored', async () => {
    const res = new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'thinking about it', thought: true }, { text: '{"status":"ok"}' }] } }], usageMetadata: {} }), { status: 200 })
    const { p } = provider([res])
    await expect(p.generate(req())).resolves.toMatchObject({ json: { status: 'ok' } })
  })
})

describe('GeminiProvider: failures (mocked provider)', () => {
  it('429 is retried with exponential backoff and honours the retry hint, then succeeds', async () => {
    const hint = [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '2s' }]
    const { p, sleeps, fetchMock } = provider([fail(429, 'rate', {}, hint), fail(429), ok({ a: 1 })])
    const r = await p.generate(req())
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(r.attempts).toBe(3)
    expect(sleeps[0]).toBeGreaterThanOrEqual(2000)
  })

  it('a daily-quota 429 is not retried and tells the user when it resets', async () => {
    const perDay = [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }]
    const { p, fetchMock } = provider([fail(429, 'quota exceeded', {}, perDay)])
    const e = (await p.generate(req()).catch((x) => x)) as LLMError
    expect(e.code).toBe('rate_limited')
    expect(e.retryable).toBe(false)
    expect(e.userMessage).toMatch(/midnight Pacific/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('429 beyond the retry budget is a normalised rate_limited error (bounded: 1 + 2 calls)', async () => {
    const { p, fetchMock } = provider([fail(429)])
    await expect(p.generate(req())).rejects.toMatchObject({ code: 'rate_limited', retryable: true })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('5xx is retried, a persistent 5xx surfaces as server_error', async () => {
    const a = provider([fail(503), ok({ a: 1 })])
    await expect(a.p.generate(req())).resolves.toMatchObject({ attempts: 2 })
    const b = provider([fail(500)])
    expect(await code(b.p.generate(req()))).toBe('server_error')
    expect(b.fetchMock).toHaveBeenCalledTimes(3)
  })

  it('a 400 that is not about the schema is never retried', async () => {
    const { p, fetchMock } = provider([fail(400, 'contents must not be empty')])
    expect(await code(p.generate(req()))).toBe('invalid_request')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('401/403 fail immediately as auth; 404 is an unknown model; neither leaks the key', async () => {
    const { p, fetchMock } = provider([fail(401, 'API key not valid')])
    const e = (await p.generate(req()).catch((x) => x)) as LLMError
    expect(e.code).toBe('auth')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(e.userMessage).not.toContain(KEY)
    expect(e.message).not.toContain(KEY)
    const nf = (await provider([fail(404, 'model not found')]).p.generate(req()).catch((x) => x)) as LLMError
    expect(nf).toMatchObject({ code: 'invalid_request', status: 404 })
  })

  it('Google reports a bad key as 400 API_KEY_INVALID: it is an auth error with a clear fix, never retried', async () => {
    const { p, fetchMock } = provider([fail(400, 'API key not valid. Please pass a valid API key.', {}, [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }])])
    const e = (await p.generate(req()).catch((x) => x)) as LLMError
    expect(e.code).toBe('auth')
    expect(e.userMessage).toMatch(/AIza/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a schema 400 steps down once from structured output to plain JSON mode without spending the retry budget', async () => {
    const { p, calls } = provider([fail(400, 'The schema produces a constraint that has too many states for serving.'), ok({ a: 1 })])
    const r = await p.generate(req())
    expect(calls.map((c) => c.body.generationConfig.responseJsonSchema !== undefined)).toEqual([true, false])
    expect(r.structuredMode).toBe('json_object')
  })

  it('a rejected thinking parameter is dropped once and the call is repeated', async () => {
    const { p, calls } = provider([fail(400, 'Thinking level is not supported for this model'), ok({ a: 1 })])
    await p.generate(req())
    expect(calls[0].body.generationConfig.thinkingConfig).toBeDefined()
    expect(calls[1].body.generationConfig.thinkingConfig).toBeUndefined()
  })

  it('a timeout aborts the request and is retried then reported as timeout', async () => {
    const hang = (init: RequestInit) => new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
    const { p, fetchMock } = provider([hang], { maxRetries: 1 })
    expect(await code(p.generate(req({ timeoutMs: 15 })))).toBe('timeout')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('a network failure is retried', async () => {
    const { p } = provider([new TypeError('fetch failed'), ok({ a: 1 })])
    await expect(p.generate(req())).resolves.toMatchObject({ attempts: 2 })
  })

  it('malformed JSON is reported and not retried inside the provider; fenced JSON is accepted', async () => {
    const bad = provider([ok('{"status": "ok", "patch": {')])
    expect(await code(bad.p.generate(req()))).toBe('malformed_json')
    expect(bad.fetchMock).toHaveBeenCalledTimes(1)
    const fenced = provider([ok('```json\n{"status":"ok"}\n```')])
    await expect(fenced.p.generate(req())).resolves.toMatchObject({ json: { status: 'ok' } })
    expect(parseJsonLoose('Sure! {"a":1} hope that helps')).toEqual({ a: 1 })
    expect(parseJsonLoose('no json here')).toBeUndefined()
  })

  it('an empty completion is retried, then reported as empty', async () => {
    const a = provider([ok(''), ok({ a: 1 })])
    await expect(a.p.generate(req())).resolves.toMatchObject({ attempts: 2 })
    const b = provider([ok('   ')])
    expect(await code(b.p.generate(req()))).toBe('empty')
  })

  it('a truncated completion (MAX_TOKENS) is reported, never parsed', async () => {
    const { p, fetchMock } = provider([ok('{"status":"ok","patch":{"ops":[', {}, 'MAX_TOKENS')])
    expect(await code(p.generate(req()))).toBe('truncated')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('safety stops and blocked prompts are normalised', async () => {
    expect(await code(provider([ok('', {}, 'SAFETY')]).p.generate(req()))).toBe('content_filter')
    const blocked = new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }), { status: 200 })
    expect(await code(provider([blocked]).p.generate(req()))).toBe('content_filter')
  })

  it('without a key it fails as misconfigured before any network call', async () => {
    const { p, fetchMock } = provider([ok({})], { apiKey: undefined })
    const e = (await p.generate(req()).catch((x) => x)) as LLMError
    expect(e.code).toBe('misconfigured')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('the key never appears in errors, user messages or logs', async () => {
    const events: AiLogEvent[] = []
    setLogSink((e) => events.push(e))
    const { p } = provider([fail(500, `upstream echo ${'x'.repeat(10)}`)], { maxRetries: 0 })
    const deps = { provider: p, models }
    const out = await runGenerate(deps, { tenantId: 't1', workspaceId: 'w1', correlationId: 'cor_1', operation: 'modify', kind: 'patch', mode: 'generate', tier: 'fast', variable: { request: 'add a field' } })
    expect(out.ok).toBe(false)
    expect(JSON.stringify([out, events])).not.toContain(KEY)
    expect(JSON.stringify(events)).not.toContain('add a field') // prompts and request text are never logged
    setLogSink((e) => console.log(`[genius-ai] ${JSON.stringify(e)}`))
  })
})

describe('QuotaTracker: free-tier budgeting', () => {
  it('blocks the request over RPM, TPM and RPD, and releases after the window', () => {
    let t = 1_000_000_000_000
    const q = new QuotaTracker({ rpm: 2, tpm: 1000, rpd: 4 }, () => t)
    expect(q.check('m', 100)).toEqual({ ok: true })
    q.record('m', 100)
    q.record('m', 100)
    expect(q.check('m', 100)).toMatchObject({ ok: false, reason: 'rpm' })
    t += 61_000
    expect(q.check('m', 100)).toEqual({ ok: true })
    expect(q.check('m', 5000)).toEqual({ ok: true }) // a request alone bigger than TPM is still the provider's call to refuse
    q.record('m', 900)
    expect(q.check('m', 500)).toMatchObject({ ok: false, reason: 'tpm' })
    t += 61_000
    q.record('m', 10)
    expect(q.check('m', 10)).toMatchObject({ ok: false, reason: 'rpd', daily: true })
    expect(q.snapshot('m')).toMatchObject({ requestsToday: 4 })
  })

  it('a daily budget stops the provider before any network call', async () => {
    const { p, fetchMock } = provider([ok({ a: 1 })], { quota: new QuotaTracker({ rpm: 100, tpm: 1e9, rpd: 1 }) })
    await p.generate(req())
    const e = (await p.generate(req()).catch((x) => x)) as LLMError
    expect(e.code).toBe('rate_limited')
    expect(e.retryable).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a 429 puts the model on cooldown so no further request is wasted', async () => {
    const q = new QuotaTracker({ rpm: 100, tpm: 1e9, rpd: 1000 })
    const { p, fetchMock } = provider([fail(429, 'rate', { 'retry-after': '120' })], { quota: q, maxRetries: 0 })
    await p.generate(req()).catch(() => undefined)
    expect(q.check(models.fast.id, 10)).toMatchObject({ ok: false, reason: 'cooldown' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('runGenerate: failure policy', () => {
  const patchOk = { status: 'ok', summary: 's', assumptions: [], questions: [], patch: { ops: [] } }
  const scripted = (script: (LLMError | unknown)[]) => {
    const seen: string[] = []
    let i = 0
    const provider: LLMProvider = {
      name: 'mock',
      async generate(r) {
        seen.push(`${r.model}@${r.maxTokens}`)
        const step = script[i++]
        if (step instanceof LLMError) throw step
        return { json: step, usage: { inputTokens: 100, outputTokens: 10, cachedTokens: 50 }, model: r.model, latencyMs: 5, attempts: 1, finishReason: 'stop', structuredMode: 'strict' }
      },
    }
    return { provider, seen }
  }
  const base = { tenantId: 't1', workspaceId: 'w1', correlationId: 'cor_1', operation: 'modify' as const, kind: 'patch' as const, mode: 'generate' as const, variable: { request: 'x' } }

  it('a spent daily quota falls back: strong -> fast -> the listed fallback models, then reports', async () => {
    const daily = () => new LLMError('rate_limited', 'tokens per day', { userMessage: 'daily limit' })
    const { provider, seen } = scripted([daily(), daily(), patchOk])
    const ok = await runGenerate({ provider, models, fallbackModels: ['q/one'] }, { ...base, tier: 'strong' })
    expect(ok.ok).toBe(true)
    expect(seen.map((s) => s.split('@')[0])).toEqual([models.strong.id, models.fast.id, 'q/one'])
    const s2 = scripted([daily(), daily(), daily()])
    const bad = await runGenerate({ provider: s2.provider, models, fallbackModels: ['q/one'] }, { ...base, tier: 'strong' })
    expect(bad.ok === false && bad.code).toBe('rate_limited')
    expect(s2.seen).toHaveLength(3)
  })

  it('truncation on the fast model escalates to the strong model once', async () => {
    const { provider, seen } = scripted([new LLMError('truncated', 'cut'), patchOk])
    const out = await runGenerate({ provider, models }, { ...base, tier: 'fast' })
    expect(out.ok).toBe(true)
    expect(out.escalated).toBe(true)
    expect(seen.map((s) => s.split('@')[0])).toEqual([models.fast.id, models.strong.id])
    expect(out.usage).toMatchObject({ inputTokens: 100, cachedTokens: 50 })
  })

  it('truncation on the strong model retries once with a larger budget, then gives up', async () => {
    const { provider, seen } = scripted([new LLMError('truncated', 'cut'), new LLMError('truncated', 'cut')])
    const out = await runGenerate({ provider, models, tpmLimit: 1_000_000 }, { ...base, tier: 'strong' })
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.code).toBe('truncated')
    const budgets = seen.map((s) => Number(s.split('@')[1]))
    expect(budgets[1]).toBeGreaterThan(budgets[0])
    expect(seen).toHaveLength(2)
  })

  it('malformed output is re-asked once on the strong model, then reported; calls are bounded', async () => {
    const { provider, seen } = scripted([new LLMError('malformed_json', 'x'), new LLMError('malformed_json', 'x'), new LLMError('malformed_json', 'x')])
    const out = await runGenerate({ provider, models }, { ...base, tier: 'fast' })
    expect(out.ok).toBe(false)
    expect(out.calls).toBeLessThanOrEqual(3)
    expect(seen).toHaveLength(2)
  })

  it('a wrong envelope is a schema_invalid error and is re-asked', async () => {
    const { provider } = scripted([{ status: 'ok' }, patchOk])
    const out = await runGenerate({ provider, models }, { ...base, tier: 'strong' })
    expect(out.ok).toBe(true)
    expect(out.calls).toBe(2)
  })

  it('a 400/413 is a problem with the request itself: reported at once, never re-sent to other models; an unknown model (404) falls back', async () => {
    const bad = () => new LLMError('invalid_request', 'HTTP 400', { status: 400, userMessage: 'could not process (HTTP 400: too large). Your CRM is unchanged.' })
    const s1 = scripted([bad(), patchOk])
    const out = await runGenerate({ provider: s1.provider, models, fallbackModels: ['gemini-x/one'] }, { ...base, tier: 'strong' })
    expect(out.ok === false && out.message).toMatch(/HTTP 400/)
    expect(s1.seen).toHaveLength(1)
    const gone = () => new LLMError('invalid_request', 'HTTP 404', { status: 404, userMessage: 'model not found' })
    const s2 = scripted([gone(), patchOk])
    const ok = await runGenerate({ provider: s2.provider, models, fallbackModels: ['gemini-3.6-flash'] }, { ...base, tier: 'strong' })
    expect(ok.ok).toBe(true)
    expect(s2.seen.map((x) => x.split('@')[0])).toEqual([models.strong.id, models.fast.id])
  })

  it('hard failures are not re-asked', async () => {
    for (const c of ['auth', 'refusal', 'content_filter', 'rate_limited', 'timeout'] as const) {
      const { provider, seen } = scripted([new LLMError(c, 'x')])
      const out = await runGenerate({ provider, models }, { ...base, tier: 'strong' })
      expect(out.ok).toBe(false)
      expect(seen).toHaveLength(1)
      expect(out.ok === false && out.message).toMatch(/CRM is unchanged/)
    }
  })

  it('strict-mode nulls are stripped before the envelope is read', () => {
    const e = parseEnvelope('patch', { status: 'ok', summary: 's', assumptions: [], questions: [], patch: { ops: [], note: null }, blueprint: null })
    expect(e.blueprint).toBeUndefined()
    expect(() => parseEnvelope('blueprint', { status: 'ok', summary: 's' })).toThrow(/blueprint missing/)
    expect(() => parseEnvelope('patch', { status: 'needs_clarification', questions: [] })).toThrow()
    expect(parseEnvelope('answer', { status: 'ok', answer: 'It is the sum of fees.', references: [] }).answer).toContain('sum')
  })
})

import { limitSchemaSize } from '#/genius/ai/json-utils'
describe('limitSchemaSize', () => {
  it('keeps small schemas untouched and bares oversized properties (nullable kept)', () => {
    const small = { type: 'object', properties: { a: { type: 'string' } } }
    expect(limitSchemaSize(small)).toEqual(small)
    const big = { type: 'object', properties: { keep: { type: 'string' }, huge: { anyOf: [{ type: 'object', properties: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, { type: 'string', description: 'x'.repeat(30) }])) }, { type: 'null' }] } } }
    const out = limitSchemaSize(big) as any
    expect(out.properties.keep).toEqual({ type: 'string' })
    expect(out.properties.huge).toEqual({ anyOf: [{ type: 'object' }, { type: 'null' }] })
  })
  it('the real blueprint contract is too big for Gemini, so it goes out as plain JSON mode with the contract in the prompt', async () => {
    const { responseSchema } = await import('#/genius/ai/ai-core')
    const s = responseSchema('blueprint')
    expect(JSON.stringify(limitSchemaSize(s))).not.toBe(JSON.stringify(s))
    const answer = responseSchema('answer')
    expect(JSON.stringify(limitSchemaSize(answer))).toBe(JSON.stringify(answer))
  })
})
