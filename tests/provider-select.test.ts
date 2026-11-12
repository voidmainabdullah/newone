import { describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { buildProvider, healthHandler, resetQuota } from '#/genius/server/handlers'
import { LLMError, type GenerateRequest } from '#/genius/ai/provider'

const req: GenerateRequest = { operation: 'modify', model: 'deepseek-flash', system: 's', user: 'u', schemaName: 'x', jsonSchema: {}, maxTokens: 100, correlationId: 'cor_1' }
const SB = { url: 'https://x.supabase.co', key: 'k' }

describe('provider selection: Gemini by default, DeepSeek only when explicitly authorised, never Groq', () => {
  it('defaults to Gemini, with or without other keys present', () => {
    resetQuota()
    expect(buildProvider({ GEMINI_API_KEY: 'a' }).provider.name).toBe('gemini')
    expect(buildProvider({ GEMINI_API_KEY: 'a', DEEPSEEK_API_KEY: 'd' }).provider.name).toBe('gemini')
    expect(buildProvider({}).provider.name).toBe('gemini')
  })

  it('DeepSeek without explicit authorisation never makes a network call', async () => {
    const f = vi.fn()
    const { provider } = buildProvider({ GENIUS_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'd' }, f as unknown as typeof fetch)
    expect(provider.name).toBe('deepseek')
    const e = (await provider.generate(req).catch((x) => x)) as LLMError
    expect(e).toBeInstanceOf(LLMError)
    expect(e.code).toBe('misconfigured')
    expect(f).not.toHaveBeenCalled()
  })

  it('a DeepSeek 402 (empty balance) is reported and never retried', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 402 }))
    const { provider } = buildProvider({ GENIUS_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'd', DEEPSEEK_ALLOW_PAID_USAGE: 'true' }, f as unknown as typeof fetch)
    const e = (await provider.generate(req).catch((x) => x)) as LLMError
    expect(e.code).toBe('auth')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('health reports the provider, whether DeepSeek is enabled and the local quota, never a key', async () => {
    resetQuota()
    const h = await healthHandler({ env: { GEMINI_API_KEY: 'AIza_SECRET', DEEPSEEK_API_KEY: 'sk_SECRET' }, supabase: SB }, undefined)
    expect(h).toMatchObject({ geminiConfigured: true, provider: 'gemini', deepseek: { enabled: false } })
    expect(JSON.stringify(h)).not.toMatch(/SECRET/)
  })

  it('no source or config file mentions Groq any more', () => {
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(ts|tsx|json)$/.test(n) && !/routeTree|bun\.lock/.test(n) && /groq/i.test(readFileSync(p, 'utf8'))) hits.push(p)
      }
    }
    walk('src')
    expect(hits).toEqual([])
  })
})
