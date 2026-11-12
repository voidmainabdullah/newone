/**
 * Local request budgeting for a rate-limited (free-tier) API. Tracks requests per minute (RPM), input tokens per
 * minute (TPM) and requests per day (RPD) per model, in process memory.
 *
 * Honest limits of this design: the provider counts per PROJECT, while this counter lives in one server isolate, so it
 * is a safety margin that avoids obviously wasted calls, not an authoritative meter. The provider's own 429 is always
 * the final word, and `cooldown()` makes a 429 stop further calls until its retry hint has passed.
 * Defaults are deliberately conservative; Google does not publish per-model free-tier numbers, so every limit is
 * configurable (GEMINI_RPM_LIMIT, GEMINI_TPM_LIMIT, GEMINI_RPD_LIMIT) and should be set from the AI Studio rate-limit page.
 */
export interface QuotaLimits {
  rpm: number
  tpm: number
  rpd: number
}

export const DEFAULT_LIMITS: QuotaLimits = { rpm: 10, tpm: 250_000, rpd: 250 }

/**
 * Limits read from the owner's AI Studio "Rate limits by model" page (free tier, November 2026): gemini-3.8-flash is
 * 5 RPM / 250K TPM / 20 RPD. Other models fall back to the configurable default; check your own project's page.
 */
export const KNOWN_LIMITS: Record<string, QuotaLimits> = { 'gemini-3.8-flash': { rpm: 5, tpm: 250_000, rpd: 20 } }

export type QuotaVerdict = { ok: true } | { ok: false; reason: 'rpm' | 'tpm' | 'rpd' | 'cooldown'; retryAfterMs: number; daily: boolean }

export interface QuotaSnapshot {
  model: string
  requestsLastMinute: number
  tokensLastMinute: number
  requestsToday: number
  limits: QuotaLimits
}

const MIN = 60_000

/** Google resets daily quotas at midnight Pacific time. UTC-8 is used as a stable approximation (no DST handling). */
const dayKey = (t: number) => Math.floor((t - 8 * 3_600_000) / 86_400_000)
const msToDayEnd = (t: number) => (dayKey(t) + 1) * 86_400_000 + 8 * 3_600_000 - t

interface Bucket {
  hits: { t: number; tokens: number }[]
  day: number
  today: number
  coolUntil: number
}

export class QuotaTracker {
  private readonly buckets = new Map<string, Bucket>()
  constructor(
    private readonly limits: QuotaLimits = DEFAULT_LIMITS,
    private readonly now: () => number = Date.now,
    /** per-model limits; a model listed here ignores `limits` */
    private readonly perModel: Record<string, QuotaLimits> = {},
  ) {}

  private limitsOf(model: string): QuotaLimits {
    return this.perModel[model] ?? this.limits
  }

  private bucket(model: string): Bucket {
    const t = this.now()
    let b = this.buckets.get(model)
    if (!b) this.buckets.set(model, (b = { hits: [], day: dayKey(t), today: 0, coolUntil: 0 }))
    b.hits = b.hits.filter((h) => t - h.t < MIN)
    if (b.day !== dayKey(t)) (b.day = dayKey(t)), (b.today = 0)
    return b
  }

  /** Would one more request of about `inputTokens` fit right now? Does not record anything. */
  check(model: string, inputTokens: number): QuotaVerdict {
    const t = this.now()
    const b = this.bucket(model)
    if (b.coolUntil > t) return { ok: false, reason: 'cooldown', retryAfterMs: b.coolUntil - t, daily: b.coolUntil - t > 10 * MIN }
    if (b.today >= this.limitsOf(model).rpd) return { ok: false, reason: 'rpd', retryAfterMs: msToDayEnd(t), daily: true }
    if (b.hits.length >= this.limitsOf(model).rpm) return { ok: false, reason: 'rpm', retryAfterMs: Math.max(250, MIN - (t - b.hits[0].t)), daily: false }
    const used = b.hits.reduce((s, h) => s + h.tokens, 0)
    if (used + inputTokens > this.limitsOf(model).tpm && b.hits.length) {
      // wait until enough of the window has aged out
      let freed = 0
      for (const h of b.hits) {
        freed += h.tokens
        if (used - freed + inputTokens <= this.limitsOf(model).tpm) return { ok: false, reason: 'tpm', retryAfterMs: Math.max(250, MIN - (t - h.t)), daily: false }
      }
      return { ok: false, reason: 'tpm', retryAfterMs: MIN, daily: false }
    }
    return { ok: true }
  }

  /** Record a request that is about to be sent (counts even if it later fails: the provider counts it too). */
  record(model: string, inputTokens: number): void {
    const b = this.bucket(model)
    b.hits.push({ t: this.now(), tokens: inputTokens })
    b.today += 1
  }

  /** The provider said 429: stop sending to this model until its hint has passed. */
  cooldown(model: string, ms: number): void {
    this.bucket(model).coolUntil = this.now() + Math.max(0, ms)
  }

  snapshot(model: string): QuotaSnapshot {
    const b = this.bucket(model)
    return { model, requestsLastMinute: b.hits.length, tokensLastMinute: b.hits.reduce((s, h) => s + h.tokens, 0), requestsToday: b.today, limits: this.limitsOf(model) }
  }

  all(): QuotaSnapshot[] {
    return [...this.buckets.keys()].map((m) => this.snapshot(m))
  }
}
