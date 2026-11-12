import { createFileRoute } from '@tanstack/react-router'
import { GenerateWire } from '#/genius/ai/wire'
import { bearerToken } from '#/genius/server/auth'
import { readServerEnv } from '#/genius/server/env'
import { generateHandler } from '#/genius/server/handlers'
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from '#/genius/supabaseConfig'

/**
 * Streaming endpoint for one model step. A new-CRM design can take a minute or more; a plain request that sends nothing
 * for that long is cut by the network ("Could not reach the server"). This route answers immediately with newline-delimited
 * JSON, sends a heartbeat line every few seconds while the model works, and ends with one `{"result": ...}` line.
 * Authentication, tenant derivation, rate limiting and size checks are unchanged: they run inside generateHandler.
 */
const enc = new TextEncoder()
const line = (o: unknown) => enc.encode(`${JSON.stringify(o)}\n`)
const HEARTBEAT_MS = 5000

export const Route = createFileRoute('/api/genius-generate')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        let wire: GenerateWire
        try {
          wire = GenerateWire.parse(await request.json())
        } catch {
          return Response.json({ ok: false, code: 'bad_request', message: 'That request was not understood. Your CRM is unchanged.', retryable: false }, { status: 400 })
        }
        const token = bearerToken(request.headers.get('authorization') ?? undefined)
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(line({ hb: 1 }))
            const timer = setInterval(() => {
              try {
                controller.enqueue(line({ hb: 1 }))
              } catch {
                /* the client went away */
              }
            }, HEARTBEAT_MS)
            try {
              const result = await generateHandler({ env: readServerEnv(), supabase: { url: SUPABASE_URL, key: SUPABASE_PUBLISHABLE_KEY } }, token, wire)
              controller.enqueue(line({ result }))
            } catch {
              controller.enqueue(line({ result: { ok: false, code: 'unavailable', message: 'The AI service failed unexpectedly. Your CRM is unchanged.', retryable: true, preservedRequest: wire.variable.request } }))
            } finally {
              clearInterval(timer)
              try {
                controller.close()
              } catch {
                /* already closed */
              }
            }
          },
        })
        return new Response(stream, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } })
      },
    },
  },
})
