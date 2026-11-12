import type { GenerateResponse, GenerateWire, Transport, TransportFailure } from '../ai/wire'
import { getAccessToken } from '../auth/authStore'
import { geniusHealth } from '../server/functions'

/**
 * Read a newline-delimited JSON stream: heartbeat lines (`{"hb":1}`) keep the connection alive while the model works,
 * the last line is `{"result": ...}`. Exported for tests.
 */
export async function readResultStream(res: Response): Promise<GenerateResponse | TransportFailure | undefined> {
  if (!res.body) return undefined
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let result: GenerateResponse | TransportFailure | undefined
  for (;;) {
    const { done, value } = await reader.read()
    buf += dec.decode(value, { stream: !done })
    let nl = buf.indexOf('\n')
    while (nl >= 0) {
      const text = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      nl = buf.indexOf('\n')
      if (!text) continue
      try {
        const o = JSON.parse(text) as { hb?: number; result?: GenerateResponse | TransportFailure }
        if (o.result) result = o.result
      } catch {
        /* a partial or unreadable line is ignored; the result line decides */
      }
    }
    if (done) break
  }
  return result
}

/** The real transport: a streaming POST carrying the Supabase access token as a Bearer header. */
export const httpTransport: Transport = async (req: GenerateWire): Promise<GenerateResponse | TransportFailure> => {
  const token = await getAccessToken()
  return streamTransport(req, token ? { authorization: `Bearer ${token}` } : {}, !token)
}

/** `fetchImpl`/`base` are injectable so the stream can be tested end to end without a browser. */
export async function streamTransport(req: GenerateWire, headers: Record<string, string>, requireToken = false, fetchImpl: typeof fetch = fetch, base = ''): Promise<GenerateResponse | TransportFailure> {
  if (requireToken) return { ok: false, code: 'auth_required', message: 'Please sign in to use Studio. Your CRM is unchanged.', retryable: false, preservedRequest: req.variable.request }
  try {
    const res = await fetchImpl(`${base}/api/genius-generate`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(req) })
    if (res.headers.get('content-type')?.includes('application/json')) return (await res.json()) as TransportFailure
    const out = await readResultStream(res)
    if (out) return out
    return { ok: false, code: 'unavailable', message: 'The connection closed before the AI answered. Nothing was changed. Please try again.', retryable: true, preservedRequest: req.variable.request }
  } catch {
    return { ok: false, code: 'unavailable', message: 'Could not reach the server. Your CRM is unchanged.', retryable: true, preservedRequest: req.variable.request }
  }
}

export async function fetchHealth() {
  const token = await getAccessToken()
  return geniusHealth({ data: {}, headers: token ? { authorization: `Bearer ${token}` } : undefined })
}
