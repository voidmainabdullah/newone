import { beforeEach, describe, expect, it } from 'vitest'
import { projectIdFor } from '#/genius/compiler/ids'
import { runGenius, MAX_FRAGMENT_ATTEMPTS, MAX_REPAIR_ATTEMPTS, type RunOutput } from '#/genius/service/run'
import { applyFragments, fragmentRootOf, planFragments } from '#/genius/service/fragment-repair'
import { schemaIssues } from '#/genius/validation'
import { Blueprint } from '#/genius/blueprint/schema'
import { parseEnvelope } from '#/genius/ai/generate'
import { MAX_REQUEST_CHARS, type GenerateResponse, type GenerateWire, type Transport, type TransportFailure } from '#/genius/ai/wire'
import { resetWorld, TENANT, WS } from './helpers'
import { schoolBlueprint } from './fixtures/school'

type Step = Record<string, unknown> | TransportFailure | Error

const envelope = (over: Record<string, unknown>) => ({ status: 'ok', summary: 'Designed it', assumptions: [], questions: [], ...over })
const okRes = (env: Record<string, unknown>): GenerateResponse => ({ ok: true, envelope: env as never, calls: 1, attempts: 1, latencyMs: 5, usage: { inputTokens: 900, outputTokens: 200, cachedTokens: 0 }, models: ['mock/fast'], escalated: false, provider: 'mock' }) as GenerateResponse

function transport(script: Step[]) {
  const seen: GenerateWire[] = []
  let i = 0
  const t: Transport = async (req) => {
    seen.push(structuredClone(req))
    const s = script[Math.min(i++, script.length - 1)]
    if (s instanceof Error) throw s
    if ('ok' in s && s.ok === false) return s as TransportFailure
    return okRes(s as Record<string, unknown>)
  }
  return { t, seen }
}

const bp = (mutate?: (b: any) => void) => {
  const b = schoolBlueprint(projectIdFor(TENANT, WS), 'rev_x') as any
  mutate?.(b)
  return b
}
const run = (request: string, t: Transport): Promise<RunOutput> => runGenius({ workspaceId: WS, request }, { transport: t })
const badRange = (b: any, v: unknown = 'whenever I feel like it') => {
  b.dashboards[0].components[0].dateRange = v
}

describe('structured schema errors', () => {
  it('an unknown dateRange is SCHEMA_INVALID_VALUE with path, allowed values, received value and a suggestion; it is never defaulted to "all"', () => {
    const raw = bp((b) => badRange(b, 'last_7_days'))
    // the server-side normaliser maps documented wording, so go through the raw schema to see the error itself
    const parsed = Blueprint.safeParse(raw)
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    const issues = schemaIssues(parsed.error, raw)
    const e = issues.find((i) => i.path.endsWith('dateRange'))!
    expect(e).toMatchObject({ code: 'SCHEMA_INVALID_VALUE', category: 'enum', allowed: ['all', '7d', '30d', '90d', 'year'], received: 'last_7_days', suggested: '7d', stage: 'schema' })
    expect(e.path).toBe('dashboards.0.components.0.dateRange')
    expect(e.message).toContain('received "last_7_days"')
  })

  it('missing required values, wrong types and bad formats get distinct codes', () => {
    const raw = bp((b) => {
      delete b.modules[0].singular
      b.modules[0].fields[0].label = 42
      b.modules[0].id = 'Bad Id'
    })
    const parsed = Blueprint.safeParse(raw)
    if (parsed.success) throw new Error('expected a failure')
    const codes = schemaIssues(parsed.error, raw).map((i) => i.code)
    expect(codes).toEqual(expect.arrayContaining(['SCHEMA_MISSING_REQUIRED', 'SCHEMA_INVALID_TYPE', 'SCHEMA_INVALID_FORMAT']))
  })
})

describe('safe normalisation', () => {
  const mk = (v: unknown) => ({ status: 'ok', summary: 's', assumptions: [], questions: [], blueprint: bp((b) => badRange(b, v)) })
  it('maps documented wording and reports what it did; leaves unknown values alone', () => {
    const e = parseEnvelope('blueprint', mk('last 30 days'))
    expect((e.blueprint as any).dashboards[0].components[0].dateRange).toBe('30d')
    expect(e.normalizations?.join(' ')).toMatch(/dateRange.*30d/)
    const odd = parseEnvelope('blueprint', mk('every other tuesday'))
    expect((odd.blueprint as any).dashboards[0].components[0].dateRange).toBe('every other tuesday')
  })
  it('an unknown key is reported when it is removed, and a spelling variant of a real key is renamed instead of dropped', () => {
    const e = parseEnvelope('blueprint', { status: 'ok', summary: 's', blueprint: bp((b) => { b.dashboards[0].components[0].date_field_id = 'f'; b.dashboards[0].components[0].pipelineStageFieldId = 'x' }) })
    const c = (e.blueprint as any).dashboards[0].components[0]
    expect(c.dateFieldId).toBe('f')
    expect('pipelineStageFieldId' in c).toBe(false)
    expect(e.normalizations?.some((n) => /renamed to "dateFieldId"/.test(n))).toBe(true)
    expect(e.normalizations?.some((n) => /pipelineStageFieldId.*removed/.test(n))).toBe(true)
  })
})

describe('fragment planner and applier (pure)', () => {
  it('finds the nearest enclosing array item and merges nested roots', () => {
    expect(fragmentRootOf('dashboards.0.components.2.dateRange')).toBe('dashboards.0.components.2')
    expect(fragmentRootOf('modules.1.fields.3.type')).toBe('modules.1.fields.3')
    expect(fragmentRootOf('ops.4.changes.label')).toBe('ops.4')
    expect(fragmentRootOf('meta.currency')).toBe('meta')
    expect(fragmentRootOf('(root)')).toBeNull()
  })
  it('refuses fragments that were not requested, changed an id, or changed shape; applies the rest', () => {
    const raw = { dashboards: [{ id: 'd', components: [{ id: 'c1', dateRange: 'x' }] }] }
    const req = [{ path: 'dashboards.0.components.0', value: raw.dashboards[0].components[0], errors: [] }]
    const r = applyFragments(raw, req, [
      { path: 'dashboards.0.components.0', valueJson: '{"id":"c1","dateRange":"7d"}' },
      { path: 'dashboards.0', valueJson: '{"id":"d"}' },
    ])
    expect((r.next as any).dashboards[0].components[0].dateRange).toBe('7d')
    expect(r.applied).toEqual(['dashboards.0.components.0'])
    expect(r.rejected[0].why).toMatch(/not a requested/)
    expect(applyFragments(raw, req, [{ path: 'dashboards.0.components.0', valueJson: '{"id":"renamed"}' }]).rejected[0].why).toMatch(/changed the id/)
    expect(applyFragments(raw, req, [{ path: 'dashboards.0.components.0', valueJson: '[1]' }]).rejected[0].why).toMatch(/same shape/)
    expect((raw.dashboards[0].components[0] as any).dateRange).toBe('x') // the original is never mutated
  })
  it('does not plan a fragment repair for reference/business errors', () => {
    expect(planFragments({}, [{ stage: 'references', code: 'REF_X', path: 'a.0', message: 'm', repair: 'r', severity: 'error' }]).ok).toBe(false)
  })
})

describe('pipeline: fragment repair', () => {
  beforeEach(() => resetWorld())

  it('repairs an invalid dashboard value by sending ONLY that component, not the CRM; nothing else changes', async () => {
    const good = bp()
    const fixedComp = { ...good.dashboards[0].components[0], dateRange: '30d' }
    const { t, seen } = transport([
      envelope({ blueprint: bp((b) => badRange(b)) }),
      envelope({ fragments: [{ path: 'dashboards.0.components.0', valueJson: JSON.stringify(fixedComp) }] }),
    ])
    const out = await run('Create a CRM for my school academy with fees in GBP', t)
    expect(out.kind === 'proposal' && out.valid).toBe(true)
    expect(seen.map((s) => `${s.kind}:${s.mode}`)).toEqual(['blueprint:generate', 'fragment:repair'])
    const frag = seen[1].variable
    // the repair request carries the fragment and its errors, and nothing else about the CRM
    expect(frag.project).toBeUndefined()
    expect(frag.context).toBeUndefined()
    expect(frag.memory).toBeUndefined()
    expect(frag.previous).toBeUndefined()
    expect(JSON.stringify(frag).length).toBeLessThan(JSON.stringify(seen[0].variable).length + 3000)
    expect(JSON.stringify(frag)).toContain('SCHEMA_INVALID_VALUE')
    expect(JSON.stringify(frag)).toContain('whenever I feel like it')
    if (out.kind !== 'proposal') return
    expect(out.proposal.blueprint?.dashboards[0].components[0].dateRange).toBe('30d')
    expect(out.proposal.blueprint?.modules.length).toBe(good.modules.length)
    expect(out.diagnostics?.attempts).toMatchObject([{ mode: 'fragment', fragments: ['dashboards.0.components.0'], outcome: 'fixed', errorsBefore: 1, errorsAfter: 0 }])
    expect(out.diagnostics?.initialErrors[0]).toMatchObject({ code: 'SCHEMA_INVALID_VALUE', path: 'dashboards.0.components.0.dateRange', received: 'whenever I feel like it', fixed: true })
  })

  it('when the fragment repair does not help, one full repair follows; total model calls stay bounded and no call repeats', async () => {
    const { t, seen } = transport([
      envelope({ blueprint: bp((b) => badRange(b)) }),
      envelope({ fragments: [{ path: 'dashboards.0.components.0', valueJson: JSON.stringify({ ...bp().dashboards[0].components[0], dateRange: 'still wrong' }) }] }),
      envelope({ blueprint: bp() }),
    ])
    const out = await run('Create a CRM for my school academy with fees in GBP', t)
    expect(out.kind === 'proposal' && out.valid).toBe(true)
    expect(seen.map((s) => `${s.kind}:${s.mode}`)).toEqual(['blueprint:generate', 'fragment:repair', 'blueprint:repair'])
    expect(seen.length).toBeLessThanOrEqual(1 + MAX_FRAGMENT_ATTEMPTS + MAX_REPAIR_ATTEMPTS)
    if (out.kind === 'proposal') expect(out.diagnostics?.attempts.map((a) => a.mode)).toEqual(['fragment', 'full'])
  })

  it('a persistently invalid design stops within budget, applies nothing and reports the exact errors', async () => {
    const { t, seen } = transport([envelope({ blueprint: bp((b) => badRange(b)) })])
    const out = await run('Create a CRM for my school academy with fees in GBP', t)
    expect(out.kind).toBe('proposal')
    if (out.kind !== 'proposal') return
    expect(out.valid).toBe(false)
    expect(out.proposal.state).toBe('draft')
    expect(out.stoppedBecause).toBeTruthy()
    expect(seen.length).toBeLessThanOrEqual(1 + MAX_FRAGMENT_ATTEMPTS + MAX_REPAIR_ATTEMPTS)
    expect(out.outcome.report.errors[0]).toMatchObject({ code: 'SCHEMA_INVALID_VALUE', path: 'dashboards.0.components.0.dateRange' })
  })

  it('a repair that changes an id is refused, not applied', async () => {
    const { t } = transport([
      envelope({ blueprint: bp((b) => badRange(b)) }),
      envelope({ fragments: [{ path: 'dashboards.0.components.0', valueJson: JSON.stringify({ ...bp().dashboards[0].components[0], id: 'renamed_by_model', dateRange: '30d' }) }] }),
      envelope({ blueprint: bp() }),
    ])
    const out = await run('Create a CRM for my school academy with fees in GBP', t)
    if (out.kind !== 'proposal') throw new Error('expected a proposal')
    expect(out.diagnostics?.attempts[0].note).toMatch(/changed the id/)
  })
})

describe('long input', () => {
  beforeEach(() => resetWorld())
  it('a request over the limit is refused with a clear message, never silently cut, and no model call is made', async () => {
    const { t, seen } = transport([envelope({ blueprint: bp() })])
    const out = await run(`Create a CRM for a school. ${'detail '.repeat(MAX_REQUEST_CHARS / 6)}`, t)
    expect(out.kind).toBe('error')
    expect(out.kind === 'error' && out.code).toBe('request_too_long')
    expect(seen).toHaveLength(0)
  })

  it('a long but allowed request reaches the model whole (no truncation marker)', async () => {
    const long = `Create a CRM for my school academy with fees in GBP. ${'Keep every detail of this requirement. '.repeat(200)}END-OF-REQUEST`
    const { t, seen } = transport([envelope({ blueprint: bp() })])
    await run(long, t)
    const sent = seen[0].variable.request
    expect(sent.length).toBeGreaterThan(7000)
    expect(sent).toContain('END-OF-REQUEST')
    expect(sent).not.toContain('characters omitted')
  })
})
