import { RateLimiter } from '../ai/cache'
import { runGenerate } from '../ai/generate'
import { DeepSeekProvider } from '../ai/deepseek'
import { GeminiProvider } from '../ai/gemini'
import { DEFAULT_FALLBACKS, MODEL_ID, resolveModels } from '../ai/models'
import { DEFAULT_LIMITS, KNOWN_LIMITS, QuotaTracker, type QuotaSnapshot } from '../ai/quota'
import type { LLMProvider } from '../ai/provider'
import { MAX_VARIABLE_CHARS, type GenerateResponse, type GenerateWire, type TransportFailure } from '../ai/wire'
import { verifyAccessToken, type SupabaseCfg } from './auth'
import type { ServerEnv } from './env'

/**
 * Transport-independent request handlers (the createServerFn wrappers in functions.ts are one-liners over these, so the
 * whole server path is unit-testable with a mocked fetch/provider and no Worker).
 *
 * Order of every handler: authenticate -> derive tenant from the verified user id -> rate limit -> size check -> work.
 * The browser never supplies a tenant id; the tenant is the verified Supabase user id.
 */
export interface ServerDeps {
  env: ServerEnv
  supabase: SupabaseCfg
  fetch?: typeof fetch
  /** inject a provider (tests); production builds a GeminiProvider from the GEMINI_API_KEY binding */
  provider?: LLMProvider
}

const limiter = new RateLimiter(30, 60_000)
export const resetServerLimiter = () => {
  // tests only
  ;(limiter as unknown as { hits: Map<string, number[]> }).hits.clear()
}

const num = (v: string | undefined, d: number, min: number, max: number) => {
  const n = Number(v)
  return Number.isFinite(n) && v !== undefined && v !== '' ? Math.min(max, Math.max(min, n)) : d
}

/** One tracker per server isolate, shared by every request: the point of a budget is that requests add up. */
let sharedQuota: QuotaTracker | undefined
export const resetQuota = () => {
  sharedQuota = undefined
}
export function quotaFor(env: ServerEnv): QuotaTracker {
  return (sharedQuota ??= new QuotaTracker({ rpm: num(env.GEMINI_RPM_LIMIT, DEFAULT_LIMITS.rpm, 1, 100_000), tpm: num(env.GEMINI_TPM_LIMIT, DEFAULT_LIMITS.tpm, 1000, 100_000_000), rpd: num(env.GEMINI_RPD_LIMIT, DEFAULT_LIMITS.rpd, 1, 10_000_000) }, undefined, env.GEMINI_RPM_LIMIT || env.GEMINI_RPD_LIMIT || env.GEMINI_TPM_LIMIT ? {} : KNOWN_LIMITS))
}

/**
 * Gemini is the default and the only provider that is ever chosen without an explicit, deliberate setting. DeepSeek is
 * used only when GENIUS_PROVIDER=deepseek AND DEEPSEEK_ALLOW_PAID_USAGE=true; a half-configured request fails loudly
 * instead of silently routing somewhere else. There is no fallback between providers.
 */
export function buildProvider(env: ServerEnv, f?: typeof fetch): { provider: LLMProvider; models: ReturnType<typeof resolveModels> } {
  const models = resolveModels(env)
  const retries = num(env.GENIUS_MAX_RETRIES, 1, 0, 6)
  if (env.GENIUS_PROVIDER?.trim().toLowerCase() === 'deepseek') {
    const allow = /^(1|true|yes)$/i.test(env.DEEPSEEK_ALLOW_PAID_USAGE?.trim() ?? '')
    const provider = new DeepSeekProvider({ apiKey: env.DEEPSEEK_API_KEY?.trim() || undefined, allowPaidUsage: allow, model: env.DEEPSEEK_MODEL?.trim() || undefined, fetch: f, maxRetries: Math.min(retries, 2) })
    return { provider, models }
  }
  // GEMINI_BASE_URL exists for local mock servers only: anything that is not localhost is ignored
  const base = env.GEMINI_BASE_URL && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(env.GEMINI_BASE_URL.trim()) ? env.GEMINI_BASE_URL.trim() : undefined
  const provider = new GeminiProvider({ apiKey: env.GEMINI_API_KEY?.trim() || undefined, models, fetch: f, quota: quotaFor(env), maxRetries: retries, baseUrl: base })
  return { provider, models }
}

const authFailure = (reason: string): TransportFailure => ({
  ok: false,
  code: reason === 'unavailable' ? 'unavailable' : 'auth_required',
  message: reason === 'unavailable' ? 'Could not verify your session right now. Please try again. Your CRM is unchanged.' : 'Please sign in to use Studio. Your CRM is unchanged.',
  retryable: reason === 'unavailable',
})

/**
 * TEST-ONLY switch: with GENIUS_E2E_NO_AUTH=true (set it in `.dev.vars`, never as a published secret) the sign-in check is
 * skipped and every request runs as one fixed test tenant, so the AI can be exercised end to end without a Supabase login.
 */
export async function authenticate(deps: ServerDeps, token: string | undefined) {
  if (deps.env.GENIUS_E2E_NO_AUTH === 'true') return { ok: true as const, userId: 'e2e_tenant', email: undefined }
  return verifyAccessToken(token, deps.supabase, deps.fetch)
}

export async function generateHandler(deps: ServerDeps, token: string | undefined, wire: GenerateWire): Promise<GenerateResponse | TransportFailure> {
  const preservedRequest = wire.variable.request
  const user = await authenticate(deps, token)
  if (!user.ok) return { ...authFailure(user.reason), preservedRequest }
  const tenantId = user.userId
  if (!limiter.take(tenantId, 'generate')) return { ok: false, code: 'rate_limited', message: 'You are sending requests too quickly. Wait a few seconds and try again. Your CRM is unchanged.', retryable: true, preservedRequest }
  if (JSON.stringify(wire.variable).length > MAX_VARIABLE_CHARS) return { ok: false, code: 'too_large', message: 'That request and its context are too large. Try a smaller, more specific request. Your CRM is unchanged.', retryable: false, preservedRequest }

  const built = deps.provider ? { provider: deps.provider, models: resolveModels(deps.env) } : buildProvider(deps.env, deps.fetch)
  const out = await runGenerate(
    { provider: built.provider, models: built.models, timeoutScale: num(deps.env.GENIUS_TIMEOUT_SCALE, 1, 0.1, 5), fallbackModels: (deps.env.GENIUS_MODEL_FALLBACKS ?? DEFAULT_FALLBACKS.join(',')).split(',').map((x) => x.trim()).filter((x) => MODEL_ID.test(x) && /^gemini-/.test(x)), tpmLimit: num(deps.env.GENIUS_INPUT_TOKEN_BUDGET, 120_000, 2000, 1_000_000) },
    { tenantId, workspaceId: wire.workspaceId, correlationId: wire.correlationId, operation: wire.operation, kind: wire.kind, mode: wire.mode, tier: wire.tier, variable: wire.variable },
  )
  const provider = ((deps.provider ?? built.provider).name === 'gemini' ? 'gemini' : (deps.provider ?? built.provider).name === 'deepseek' ? 'deepseek' : 'mock') as GenerateResponse['provider']
  return out.ok ? { ...out, provider } : { ...out, provider, preservedRequest }
}

export interface HealthInfo {
  /** true when the GEMINI_API_KEY binding is visible to the server (the key itself is never returned) */
  geminiConfigured: boolean
  /** which provider answers requests; DeepSeek only ever when deliberately enabled */
  provider: 'gemini' | 'deepseek'
  deepseek: { enabled: boolean; reason: string }
  /** local request/token budget per model (RPM, TPM, RPD) */
  quota: QuotaSnapshot[]
  models: { fast: string; strong: string }
  thinking: { fast: string; strong: string }
  strictJsonSchema: { fast: boolean; strong: boolean }
  promptCaching: { fast: boolean; strong: boolean }
  supabaseConfigured: boolean
  session?: { tenantId: string; email?: string } | { error: string }
}

export async function healthHandler(deps: ServerDeps, token: string | undefined): Promise<HealthInfo> {
  const m = resolveModels(deps.env)
  const info: HealthInfo = {
    geminiConfigured: !!deps.env.GEMINI_API_KEY?.trim(),
    provider: deps.env.GENIUS_PROVIDER?.trim().toLowerCase() === 'deepseek' ? 'deepseek' : 'gemini',
    deepseek: /^(1|true|yes)$/i.test(deps.env.DEEPSEEK_ALLOW_PAID_USAGE?.trim() ?? '') && !!deps.env.DEEPSEEK_API_KEY?.trim() ? { enabled: true, reason: 'explicitly authorised' } : { enabled: false, reason: 'disabled: needs DEEPSEEK_API_KEY and DEEPSEEK_ALLOW_PAID_USAGE=true' },
    quota: quotaFor(deps.env).all(),
    models: { fast: m.fast.id, strong: m.strong.id },
    thinking: { fast: m.fast.thinkingLevel ?? 'off', strong: m.strong.thinkingLevel ?? 'off' },
    strictJsonSchema: { fast: m.fast.strictJsonSchema, strong: m.strong.strictJsonSchema },
    promptCaching: { fast: m.fast.promptCaching, strong: m.strong.promptCaching },
    supabaseConfigured: !!deps.supabase.url && !!deps.supabase.key,
  }
  if (token) {
    const u = await authenticate(deps, token)
    info.session = u.ok ? { tenantId: u.userId, email: u.email } : { error: u.reason }
  }
  return info
}
