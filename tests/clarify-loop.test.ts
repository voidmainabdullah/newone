import { beforeEach, describe, expect, it } from 'vitest'
import { runGenius } from '#/genius/service/run'
import type { Transport } from '#/genius/ai/wire'
import { resetWorld, WS } from './helpers'

const ok = (envelope: unknown) => ({ ok: true as const, envelope: envelope as never, calls: 1, attempts: 1, latencyMs: 1, usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 }, models: ['mock'], escalated: false, provider: 'mock' as const })

describe('the model asks something that was already answered', () => {
  beforeEach(() => resetWorld())
  it('is told to stop asking and answer, instead of failing the request', async () => {
    const requests: string[] = []
    const t: Transport = async (req) => {
      requests.push(req.variable.request)
      return requests.length === 1
        ? ok({ status: 'needs_clarification', assumptions: [], questions: [{ id: 'currency', question: 'Currency?', why: 'money', options: ['GBP'], safeDefault: 'GBP' }] })
        : ok({ status: 'ok', answer: 'You have no modules yet.', references: [] })
    }
    const out = await runGenius({ workspaceId: WS, request: 'How many modules do I have?', answers: [{ questionId: 'currency', question: 'Currency?', answer: 'GBP', at: new Date().toISOString() }] }, { transport: t })
    expect(out.kind).toBe('answer')
    expect(requests).toHaveLength(2)
    expect(requests[1]).toMatch(/Do NOT ask any questions/)
  })
})
