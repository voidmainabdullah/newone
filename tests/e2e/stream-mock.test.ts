import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { projectIdFor } from '#/genius/compiler/ids'
import { runGenius, type StepEvent } from '#/genius/service/run'
import { streamTransport } from '#/genius/service/transport'
import type { Transport } from '#/genius/ai/wire'
import { resetWorld, TENANT, WS } from '../helpers'
import { schoolBlueprint } from '../fixtures/school'

/**
 * End to end through the REAL dev server: streaming route -> generateHandler -> GeminiProvider -> a local mock of the
 * Gemini API (503 first, then a slow answer) -> validation -> preview. Needs the dev server started with `.dev.vars`
 * (GENIUS_E2E_NO_AUTH, GEMINI_BASE_URL=http://localhost:9099). Run: E2E_DEV_URL=http://localhost:61181 bun run vitest run tests/e2e/stream-mock
 */
const DEV = process.env.E2E_DEV_URL
describe.skipIf(!DEV)('streaming route + mock Gemini', () => {
  it('survives a 503 and a 25 s answer (longer than any idle timeout) and produces a validated preview', async () => {
    resetWorld()
    const seen: { n: number; at: number; schema: boolean }[] = []
    const bp = schoolBlueprint(projectIdFor(TENANT, WS), 'rev_x')
    const srv = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const j = JSON.parse(body)
        seen.push({ n: seen.length + 1, at: Date.now(), schema: !!j.generationConfig?.responseJsonSchema })
        if (seen.length === 1) {
          res.writeHead(503, { 'content-type': 'application/json' })
          return void res.end(JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'The model is overloaded.' } }))
        }
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ status: 'ok', summary: 'Designed', assumptions: [], questions: [], blueprint: bp }) }] } }], usageMetadata: { promptTokenCount: 4000, candidatesTokenCount: 3000 } }))
        }, 25_000)
      })
    })
    await new Promise<void>((r) => srv.listen(9099, r))
    try {
      const transport: Transport = (req) => streamTransport(req, {}, false, fetch, DEV)
      const events: StepEvent[] = []
      const t0 = Date.now()
      const out = await runGenius({ workspaceId: WS, request: 'Create a CRM for my school academy with fees in GBP', onStep: (e) => events.push(e) }, { transport })
      console.log('elapsed ms', Date.now() - t0, 'mock calls', seen.length, 'steps', events.map((e) => `${e.id}:${e.status}`).join(' '))
      expect(out.kind).toBe('proposal')
      if (out.kind === 'proposal') expect(out.valid).toBe(true)
      expect(seen.length).toBe(2)
      expect(seen[0].schema).toBe(true)
      expect(Date.now() - t0).toBeGreaterThan(24_000)
    } finally {
      srv.close()
    }
  }, 120_000)
})
