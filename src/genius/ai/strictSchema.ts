import { z } from 'zod'

type Json = Record<string, unknown>

/** keywords strict structured-output engines commonly reject; the same rules are enforced locally by zod after parsing */
const UNSUPPORTED = new Set(['pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minItems', 'maxItems', 'format', 'multipleOf', '$schema', 'default', 'examples', 'propertyNames', 'uniqueItems'])

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * Convert a zod-generated JSON Schema into the shape strict `json_schema` mode requires:
 *  - every object lists ALL its properties as required and sets additionalProperties:false
 *  - properties that were optional become nullable (the model sends null, `stripNulls` removes it before zod parses)
 *  - oneOf becomes anyOf; validation keywords strict mode rejects are dropped (zod enforces them locally)
 * Pure and deterministic: the same input always produces byte-identical output (it is part of the cached prefix).
 */
export function toStrictSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toStrictSchema)
  if (!isObj(node)) return node
  const out: Json = {}
  for (const [k, v] of Object.entries(node)) {
    if (UNSUPPORTED.has(k)) continue
    if (k === 'oneOf') {
      out.anyOf = toStrictSchema(v)
      continue
    }
    if (k === 'properties' && isObj(v)) {
      const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : [])
      const props: Json = {}
      for (const [pk, pv] of Object.entries(v)) {
        const converted = toStrictSchema(pv)
        props[pk] = required.has(pk) ? converted : { anyOf: [converted, { type: 'null' }] }
      }
      out.properties = props
      out.required = Object.keys(props)
      out.additionalProperties = false
      continue
    }
    if (k === 'required' || k === 'additionalProperties') continue
    out[k] = toStrictSchema(v)
  }
  if (out.type === 'object' && !('properties' in out)) {
    out.properties = {}
    out.required = []
    out.additionalProperties = false
  }
  return out
}

/** Remove `null` object members that only exist because strict mode forced optional fields to be nullable. */
export function stripNulls<T>(v: T): T {
  if (Array.isArray(v)) return v.map(stripNulls) as T
  if (isObj(v)) {
    const out: Json = {}
    for (const [k, x] of Object.entries(v)) if (x !== null) out[k] = stripNulls(x)
    return out as T
  }
  return v
}

export function strictJsonSchemaFor(schema: z.ZodType): Json {
  const raw = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any', reused: 'inline', cycles: 'throw' }) as Json
  return toStrictSchema(raw) as Json
}

/**
 * Compact TypeScript-like rendering of a zod schema, sent in the system prompt when the provider is used in plain JSON
 * mode (no response_format schema). Models cannot follow a contract they never see. Keys ending in `?` are optional.
 * Deterministic: it is part of the cached static prefix.
 */
export function compactSchemaFor(schema: z.ZodType): string {
  const raw = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any', reused: 'inline', cycles: 'throw' }) as Json
  const lit = (v: unknown) => JSON.stringify(v)
  const counts = new Map<string, number>()
  const aliases = new Map<string, string>()
  const defs: string[] = []
  let pass = 1
  /** returns [full text, text with repeated sub-shapes replaced by aliases] */
  const walk = (n: unknown): [string, string] => {
    const same = (t: string): [string, string] => [t, t]
    if (!isObj(n)) return same('any')
    if ('const' in n) return same(lit(n.const))
    if (Array.isArray(n.enum)) return same(n.enum.map(lit).join('|'))
    const alt = (n.anyOf ?? n.oneOf) as unknown[] | undefined
    if (Array.isArray(alt)) {
      const parts = alt.map(walk)
      return [[...new Set(parts.map((x) => x[0]))].join('|'), [...new Set(parts.map((x) => x[1]))].join('|')]
    }
    if (Array.isArray(n.type)) {
      const parts = n.type.map((t) => walk({ ...n, type: t }))
      return [[...new Set(parts.map((x) => x[0]))].join('|'), [...new Set(parts.map((x) => x[1]))].join('|')]
    }
    switch (n.type) {
      case 'object': {
        const props = isObj(n.properties) ? n.properties : {}
        const req = new Set(Array.isArray(n.required) ? (n.required as string[]) : [])
        const full: string[] = []
        const short: string[] = []
        for (const [k, v] of Object.entries(props)) {
          const [f, sh] = walk(v)
          full.push(`${k}${req.has(k) ? '' : '?'}:${f}`)
          short.push(`${k}${req.has(k) ? '' : '?'}:${sh}`)
        }
        if (isObj(n.additionalProperties)) {
          const [f, sh] = walk(n.additionalProperties)
          full.push(`[key:string]:${f}`)
          short.push(`[key:string]:${sh}`)
        } else if (n.additionalProperties === true && !full.length) return same('object')
        const f = `{${full.join(',')}}`
        let sh = `{${short.join(',')}}`
        if (pass === 1) counts.set(f, (counts.get(f) ?? 0) + 1)
        else if (f.length > 120 && (counts.get(f) ?? 0) >= 2) {
          let a = aliases.get(f)
          if (!a) {
            a = `T${aliases.size + 1}`
            aliases.set(f, a)
            defs.push(`${a} = ${sh}`)
          }
          sh = a
        }
        return [f, sh]
      }
      case 'array': {
        const [f, sh] = walk(n.items)
        const wrap = (t: string) => (t.includes('|') && !/^[{(]/.test(t) ? `(${t})[]` : /^[^{(]*\|/.test(t) ? `(${t})[]` : `${t}[]`)
        return [wrap(f), wrap(sh)]
      }
      case 'string':
        return same(typeof n.minLength === 'number' && n.minLength > 1 ? `string(min ${n.minLength} chars)` : 'string')
      case 'integer':
      case 'number':
        return same('number')
      case 'boolean':
        return same('boolean')
      case 'null':
        return same('null')
      default:
        return same('any')
    }
  }
  walk(raw)
  pass = 2
  const body = walk(raw)[1]
  return defs.length ? `${defs.join('\n')}\nRESPONSE = ${body}` : body
}

const prunable = new WeakMap<object, Json>()

const normKey = (x: unknown) => String(x).toLowerCase().replace(/[\s_\-]/g, '')

/**
 * Make model output fit a closed schema WITHOUT changing what it means, and report every change in `notes`:
 *  - an unknown key that is only a spelling variant of a missing allowed key is renamed to it (`date_field_id` -> `dateFieldId`);
 *  - any other unknown key (the model invented it, the schema says additionalProperties:false) is removed and listed;
 *  - a required list the model left out becomes [] (the documented canonical default for lists);
 *  - an enum value that differs only in case, spacing or punctuation becomes the exact enum value;
 *  - "true"/"12"/12 style primitives are coerced only when the schema's type makes the meaning obvious.
 * Anything else (a value that is wrong, not merely spelled differently) is left alone so validation reports it precisely.
 * Unions are visited only when exactly one variant matches the discriminating constants (e.g. a patch op's `op`).
 * Returns the number of changes. Mutates `data`.
 */
export function pruneToSchema(data: unknown, schema: z.ZodType, notes?: string[]): number {
  let raw = prunable.get(schema)
  if (!raw) {
    raw = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any', reused: 'inline', cycles: 'throw' }) as Json
    prunable.set(schema, raw)
  }
  let changes = 0
  const note = (m: string) => {
    changes++
    if (notes && notes.length < 60) notes.push(m)
  }
  const visit = (d: unknown, n: unknown, path: string): void => {
    if (!isObj(n)) return
    const alt = (n.anyOf ?? n.oneOf) as unknown[] | undefined
    if (Array.isArray(alt)) {
      if (!isObj(d)) {
        if (Array.isArray(d)) for (const v of alt) if (isObj(v) && v.type === 'array') return visit(d, v, path)
        return
      }
      const fits = alt.filter((v) => isObj(v) && isObj(v.properties) && Object.entries(v.properties).every(([k, p]) => !isObj(p) || !('const' in p) || d[k] === p.const) && Object.values(v.properties).some((p) => isObj(p) && 'const' in p))
      if (fits.length === 1) visit(d, fits[0], path)
      else if (alt.filter((v) => isObj(v) && v.type === 'object').length === 1) visit(d, alt.find((v) => isObj(v) && v.type === 'object'), path)
      return
    }
    if (n.type === 'array' && Array.isArray(d)) {
      d.forEach((it, i) => visit(it, n.items, path ? `${path}.${i}` : String(i)))
      return
    }
    if (n.type === 'object' && isObj(d) && isObj(n.properties)) {
      const props = n.properties
      const at = (k: string) => (path ? `${path}.${k}` : k)
      if (n.additionalProperties === false)
        for (const k of Object.keys(d)) {
          if (k in props) continue
          const twin = Object.keys(props).find((p) => !(p in d) && normKey(p) === normKey(k))
          if (twin) {
            d[twin] = d[k]
            delete d[k]
            note(`${at(k)}: key renamed to "${twin}"`)
          } else {
            delete d[k]
            note(`${at(k)}: unknown key removed (not part of the schema)`)
          }
        }
      // a required list the model left out is an empty list
      if (Array.isArray(n.required)) for (const k of n.required as string[]) if (d[k] === undefined && isObj(props[k]) && props[k].type === 'array') (d[k] = []), note(`${at(k)}: missing list set to []`)
      for (const [k, p] of Object.entries(props)) {
        if (!(k in d)) continue
        if (isObj(p) && Array.isArray(p.enum) && typeof d[k] === 'string' && !p.enum.includes(d[k])) {
          const hit = p.enum.find((e) => normKey(e) === normKey(d[k]))
          if (hit !== undefined) {
            note(`${at(k)}: "${String(d[k]).slice(0, 40)}" normalised to "${String(hit)}"`)
            d[k] = hit
          }
        }
        if (isObj(p)) {
          const v = d[k]
          if (p.type === 'object' && Array.isArray(v) && v.length === 1 && isObj(v[0])) (d[k] = v[0]), note(`${at(k)}: single-item list unwrapped`)
          if (p.type === 'boolean' && typeof v === 'string') {
            const t = v.trim().toLowerCase()
            if (['true', 'yes', 'y', '1', 'on'].includes(t)) (d[k] = true), note(`${at(k)}: "${t}" -> true`)
            else if (['false', 'no', 'n', '0', 'off'].includes(t)) (d[k] = false), note(`${at(k)}: "${t}" -> false`)
          } else if (p.type === 'boolean' && typeof v === 'number' && (v === 0 || v === 1)) (d[k] = v === 1), note(`${at(k)}: ${v} -> ${v === 1}`)
          else if ((p.type === 'number' || p.type === 'integer') && typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) (d[k] = Number(v)), note(`${at(k)}: numeric string -> number`)
          else if (p.type === 'string' && (typeof v === 'number' || typeof v === 'boolean') && !Array.isArray(p.enum)) (d[k] = String(v)), note(`${at(k)}: ${typeof v} -> string`)
        }
        visit(d[k], p, at(k))
      }
    }
  }
  visit(data, raw, '')
  return changes
}
