import { describe, expect, it } from 'vitest'
import { runGenius, type StepEvent } from '#/genius/service/run'
import { buildProvider, resetQuota } from '#/genius/server/handlers'
import { runGenerate } from '#/genius/ai/generate'
import { setLogSink } from '#/genius/ai/observability'
import type { Transport } from '#/genius/ai/wire'
import { streamTransport } from '#/genius/service/transport'
import { acceptProposal } from '#/genius/service/builder'
import { useModuleStore } from '#/stores/moduleStore'
import { resetWorld, WS } from '../helpers'

/**
 * LIVE end-to-end test: real Gemini, no sign-in. Runs only when GEMINI_API_KEY is in the environment:
 *   GEMINI_API_KEY=... GENIUS_E2E_PROMPT="..." bun run vitest run tests/e2e
 * It uses the same pipeline as the Studio page (intent -> context -> model -> validate -> repair -> preview) and calls
 * runGenerate directly instead of the authenticated server function.
 */
const KEY = process.env.GEMINI_API_KEY
const env = { ...process.env } as Record<string, string | undefined>
const logs: unknown[] = []
setLogSink((e) => logs.push(e))

describe.skipIf(!KEY)('live Gemini', () => {
  it('builds a CRM from one prompt', async () => {
    resetWorld()
    resetQuota()
    const { provider, models } = buildProvider(env)
    // with E2E_DEV_URL the request goes through the real streaming route of the dev server (same code path as the site)
    const transport: Transport = process.env.E2E_DEV_URL ? (req) => streamTransport(req, {}, false, fetch, process.env.E2E_DEV_URL) : async (req) => {
      const out = await runGenerate({ provider, models, tpmLimit: 120_000, fallbackModels: [] }, { tenantId: 'e2e', workspaceId: req.workspaceId, correlationId: req.correlationId, operation: req.operation, kind: req.kind, mode: req.mode, tier: req.tier, variable: req.variable as never })
      console.log('MODEL STEP', JSON.stringify({ kind: req.kind, ok: out.ok, calls: out.calls, ms: out.latencyMs, usage: out.usage, models: out.models, mode: out.structuredMode, ...(out.ok ? {} : { code: out.code, message: out.message }) }))
      return { ...out, provider: 'gemini' } as never
    }
    const prompt = process.env.GENIUS_E2E_PROMPT ?? 'Create a CRM for a hostel in GBP: hostels, rooms, residents, bookings and payments. Bookings link a resident to a room, payments link to a booking.'
    const events: StepEvent[] = []
    const out = await runGenius({ workspaceId: WS, request: prompt, onStep: (e) => events.push(e) }, { transport })
    console.log('STEPS', events.map((e) => `${e.id}:${e.status}:${e.detail ?? ''}:${e.ms ?? ''}ms`).join('\n'))
    if (out.kind === 'proposal') {
      console.log('RESULT proposal valid=', out.valid, 'modules=', out.proposal.blueprint?.modules.map((m) => m.id).join(','), 'errors=', JSON.stringify(out.outcome.report.errors.slice(0, 5)), 'diag=', JSON.stringify(out.diagnostics?.attempts), 'norm=', out.diagnostics?.normalizations.length, 'stopped=', out.stoppedBecause)
    } else console.log('RESULT', out.kind, JSON.stringify(out).slice(0, 600))
    expect(out.kind).toBe('proposal')
    if (out.kind === 'proposal' && out.valid) {
      const applied = acceptProposal(out.proposal.id)
      console.log('APPLIED', applied.ok, 'modules in store:', useModuleStore.getState().modules.map((m) => m.name).join(', '))
      expect(applied.ok).toBe(true)
    }
  }, 300_000)
})
