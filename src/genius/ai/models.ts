/**
 * Model configuration (Google Gemini). Model ids come from the environment (`GENIUS_MODEL_FAST`, `GENIUS_MODEL_STRONG`)
 * so they can be changed without a code change. Capability flags are per model; every flag can be forced from the
 * environment:
 *   GENIUS_MODEL_FAST_STRICT=true|false      structured output via `responseJsonSchema` (otherwise plain JSON mode + local validation)
 *   GENIUS_MODEL_FAST_CACHING=true|false     report cached prompt tokens
 *   GENIUS_MODEL_FAST_THINKING=minimal|low|medium|high|off   (same for _STRONG)
 *
 * The defaults are models Google lists as free of charge on the Gemini Developer API free tier (checked November 2026:
 * gemini-3.8-flash, gemini-3.5-flash-lite). Free-tier limits are per project and not published per model, so they are
 * tracked locally (see quota.ts) and configurable. Nothing here selects a paid-only model.
 */
export interface ModelCaps {
  id: string
  tier: 'fast' | 'strong'
  /** structured output through `generationConfig.responseJsonSchema` */
  strictJsonSchema: boolean
  /** plain `responseMimeType: application/json` */
  jsonObject: boolean
  /** implicit prompt caching of a repeated static prefix (reported as cachedContentTokenCount) */
  promptCaching: boolean
  /** a thinking model: thought tokens count toward the output budget */
  reasoning: boolean
  /** Gemini 3 `thinkingLevel`; undefined = leave the model default */
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high'
  contextTokens: number
  maxOutputTokens: number
}

export const DEFAULT_FAST = 'gemini-3.5-flash-lite'
export const DEFAULT_STRONG = 'gemini-3.8-flash'
/** tried in order only when a model's daily quota is spent or the model id is rejected as unknown; all free-tier models */
export const DEFAULT_FALLBACKS = ['gemini-3.1-flash-lite', 'gemini-3.6-flash']

type Known = Omit<ModelCaps, 'id' | 'tier' | 'thinkingLevel'>

const GEMINI: Known = { strictJsonSchema: true, jsonObject: true, promptCaching: true, reasoning: true, contextTokens: 1_048_576, maxOutputTokens: 65_536 }
/** unknown ids get the conservative profile: plain JSON mode, small output, no caching assumption */
const CONSERVATIVE: Known = { strictJsonSchema: false, jsonObject: true, promptCaching: false, reasoning: false, contextTokens: 32_768, maxOutputTokens: 8192 }

export const KNOWN_MODELS: Record<string, Known> = {
  'gemini-3.8-flash': GEMINI,
  'gemini-3.6-flash': GEMINI,
  'gemini-3.5-flash': GEMINI,
  'gemini-3.5-flash-lite': GEMINI,
  'gemini-3.1-flash-lite': GEMINI,
}

type Env = Record<string, string | undefined>

const flag = (v: string | undefined, fallback: boolean) => (v === undefined || v === '' ? fallback : /^(1|true|yes|on)$/i.test(v.trim()))

export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._\-/:]{1,100}$/

const LEVELS = new Set(['minimal', 'low', 'medium', 'high'])

function resolveOne(env: Env, tier: 'fast' | 'strong'): ModelCaps {
  const T = tier.toUpperCase()
  const raw = env[`GENIUS_MODEL_${T}`]?.trim()
  const id = raw && MODEL_ID.test(raw) ? raw : tier === 'fast' ? DEFAULT_FAST : DEFAULT_STRONG
  const base = KNOWN_MODELS[id] ?? (/^gemini-/.test(id) ? GEMINI : CONSERVATIVE)
  const t = env[`GENIUS_MODEL_${T}_THINKING`]?.trim().toLowerCase()
  const thinkingLevel = t === 'off' ? undefined : t && LEVELS.has(t) ? (t as ModelCaps['thinkingLevel']) : base.reasoning ? 'low' : undefined
  return {
    id,
    tier,
    ...base,
    thinkingLevel,
    strictJsonSchema: flag(env[`GENIUS_MODEL_${T}_STRICT`], base.strictJsonSchema),
    promptCaching: flag(env[`GENIUS_MODEL_${T}_CACHING`], base.promptCaching),
  }
}

export interface ModelSet {
  fast: ModelCaps
  strong: ModelCaps
}

export function resolveModels(env: Env): ModelSet {
  return { fast: resolveOne(env, 'fast'), strong: resolveOne(env, 'strong') }
}

/**
 * Output budget per operation (output tokens, including thinking). Gemini models allow far larger answers than the
 * previous provider, so a new build can be designed in one piece; the router still escalates on truncation.
 */
export const MAX_TOKENS: Record<'new_build' | 'modify' | 'repair' | 'question', number> = {
  new_build: 28_000,
  modify: 12_000,
  repair: 12_000,
  question: 2_000,
}
export const TIMEOUT_MS: Record<'new_build' | 'modify' | 'repair' | 'question', number> = {
  new_build: 200_000,
  modify: 120_000,
  repair: 90_000,
  question: 30_000,
}
export const TEMPERATURE = 0.1
