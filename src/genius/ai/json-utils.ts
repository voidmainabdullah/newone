/** Tolerant JSON helpers shared by every provider adapter. Server-safe (no imports). */

/** Tolerant JSON extraction: plain JSON, ```json fences, or prose around one object. Returns undefined when nothing parses. */
export function parseJsonLoose(text: string): unknown | undefined {
  const t = text.trim()
  const attempts = [t]
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t)
  if (fence) attempts.push(fence[1])
  const a = t.indexOf('{')
  const b = t.lastIndexOf('}')
  if (a >= 0 && b > a) attempts.push(t.slice(a, b + 1))
  for (const s of attempts) {
    try {
      return JSON.parse(s)
    } catch {
      /* try the next shape */
    }
  }
  return undefined
}

/** Keep the first complete top-level JSON object and drop anything after it (stray quotes or braces some models append). */
export function salvageJson(text: string): unknown | undefined {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1))
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

export const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

type J = Record<string, unknown>
const isObj = (v: unknown): v is J => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * Gemini rejects a response schema that is too large or deeply nested as a whole ("HTTP 400: Request contains an invalid
 * argument", with no hint), even when every part of it is fine on its own (checked against the live API in November 2026:
 * the full blueprint schema is refused, each top-level section alone is accepted). So the schema sent to the API keeps the
 * top-level shape and replaces any property bigger than `maxChars` by a bare `{type}`. The full contract still reaches the
 * model as the compact schema in the system prompt and is enforced locally by the validators (plus targeted repair).
 * Pure and deterministic.
 */
export function limitSchemaSize(schema: unknown, maxChars = 2500): unknown {
  if (!isObj(schema)) return schema
  const shrink = (p: unknown): unknown => {
    if (!isObj(p) || JSON.stringify(p).length <= maxChars) return p
    const alt = Array.isArray(p.anyOf) ? (p.anyOf as unknown[]) : undefined
    const nullable = !!alt?.some((x) => isObj(x) && x.type === 'null')
    const core = alt ? ((alt.find((x) => isObj(x) && x.type !== 'null') as J | undefined) ?? {}) : p
    const type = core.type === 'array' ? 'array' : 'object'
    const bare: J = type === 'array' ? { type: 'array', items: { type: 'object' } } : { type: 'object' }
    return nullable ? { anyOf: [bare, { type: 'null' }] } : bare
  }
  const walk = (n: unknown): unknown => {
    if (!isObj(n)) return n
    if (isObj(n.properties)) return { ...n, properties: Object.fromEntries(Object.entries(n.properties).map(([k, v]) => [k, walk(shrink(v))])) }
    return n
  }
  return walk(schema)
}
