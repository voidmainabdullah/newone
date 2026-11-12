import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { CAPABILITIES, REGISTERED_OPS, capabilityDigest } from '#/genius/capabilities'
import { staticPrefix } from '#/genius/ai/ai-core'

describe('capability registry', () => {
  it('registers every patch operation the schema defines', () => {
    const src = readFileSync(new URL('../src/genius/blueprint/schema.ts', import.meta.url), 'utf8')
    const ops = [...src.matchAll(/op: z\.literal\('([a-z_]+)'\)/g)].map((m) => m[1])
    expect(ops.length).toBeGreaterThan(20)
    for (const op of ops) expect(REGISTERED_OPS.has(op), `${op} is not in the capability registry`).toBe(true)
  })
  it('has unique ids, and unsupported entries never claim operations', () => {
    expect(new Set(CAPABILITIES.map((c) => c.id)).size).toBe(CAPABILITIES.length)
    for (const c of CAPABILITIES.filter((x) => x.status === 'unsupported')) expect(c.ops).toEqual([])
  })
  it('tells the model what is not available', () => {
    expect(staticPrefix('answer')).toContain('NOT AVAILABLE YET')
    expect(staticPrefix('blueprint')).toContain('Branching workflow graph')
    expect(capabilityDigest()).toMatch(/Search \(typed QuerySpec\)/)
  })
})
