import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GenerateResponse, GenerateWire, Transport, TransportFailure } from '#/genius/ai/wire'
import { GenerateWire as WireSchema } from '#/genius/ai/wire'
import { parseEnvelope } from '#/genius/ai/generate'
import { responseSchema, staticPrefix } from '#/genius/ai/ai-core'
import { runGenius, type RunOutput, type StepEvent } from '#/genius/service/run'
import { confirmDraft, checkCandidate, type ConfigDraft } from '#/genius/service/configure'
import { useGeniusStore } from '#/genius/state/geniusStore'
import { useEngineStore } from '#/stores/engineStore'
import { useConfigNav } from '#/stores/configNavStore'
import { useSelectionStore } from '#/stores/selectionStore'
import { useRecordStore } from '#/stores/recordStore'
import { useSettingsStore } from '#/stores/settingsStore'
import { visibleDashboards } from '#/engine/dashboards'
import type { CalculationBody, ConditionalRuleBody, DashboardBody } from '#/engine/schema'
import { putModules, recordsOf } from './engine-fixtures'
import { resetWorld, WS } from './helpers'
import { schoolModules, schoolRecords } from './engine-nl-fixtures'

const mocked = vi.hoisted(() => ({ transport: undefined as undefined | ((req: unknown) => Promise<unknown>) }))
vi.mock('#/genius/service/transport', () => ({
  httpTransport: (req: unknown) => (mocked.transport ? mocked.transport(req) : Promise.resolve({ ok: false, code: 'unavailable', message: 'offline', retryable: true })),
  fetchHealth: async () => ({}),
}))
import { cancelConfig, confirmConfig, editConfig, sendToStudio, skipAsked, useStudioStore } from '#/stores/studioStore'

type Script = (Record<string, unknown> | TransportFailure | Error)[]
const okRes = (env: Record<string, unknown>): GenerateResponse =>
  ({ ok: true, envelope: env as never, calls: 1, attempts: 1, latencyMs: 9, usage: { inputTokens: 900, outputTokens: 200, cachedTokens: 0 }, models: ['mock/strong'], escalated: false, provider: 'mock' }) as GenerateResponse

/** A scripted stand-in for the server function (the model). Records every request it receives. */
function transport(script: Script) {
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
const OFFLINE: TransportFailure = { ok: false, code: 'unavailable', message: 'The AI service is not connected.', retryable: true }
const run = (request: string, t: Transport, extra: { answers?: { questionId: string; question: string; answer: string; at: string }[]; onStep?: (e: StepEvent) => void } = {}): Promise<RunOutput> => runGenius({ workspaceId: WS, request, ...extra }, { transport: t })
const engineDoc = () => useEngineStore.getState().docOf(WS)
const nothingSaved = () => {
  expect(engineDoc().calculations).toHaveLength(0)
  expect(engineDoc().conditional_rules).toHaveLength(0)
  expect(engineDoc().dashboards.filter((d) => d.id !== undefined && d.name !== 'Overview')).toHaveLength(0)
}
const BALANCE = 'Automatically calculate remaining amount by subtracting paid amount from total amount'
const draftOf = (out: RunOutput): ConfigDraft => {
  expect(out.kind).toBe('configure')
  if (out.kind !== 'configure') throw new Error(`expected a draft, got ${out.kind}`)
  return out.draft
}
const goodCalc: CalculationBody = { type: 'calculation', name: 'Balance', entity: 'mod_fees', output_field: 'remaining_amount', operation: 'subtract', inputs: [{ field: 'total_amount', default: 0 }, { field: 'paid_amount', default: 0 }], trigger: 'on_record_change', output: { label: 'Remaining amount' } }
// a phrasing the built-in parser does not cover, so only the model (or nothing) can answer it
const ODD = 'Calculate remaining amount using a weighted formula of total amount and paid amount'

beforeEach(() => {
  resetWorld()
  putModules(...schoolModules())
  useRecordStore.getState().setAll(schoolRecords())
  mocked.transport = undefined
  useStudioStore.getState().reset(WS)
  useConfigNav.setState({ module: null, dashboard: null, tab: null })
})

describe('the AI path never trusts the model', () => {
  it('sends the model only the real schema, a strict config schema, and nothing from the records', async () => {
    const { t, seen } = transport([{ status: 'ok', summary: 'Remaining = total − paid.', assumptions: [], config: goodCalc }])
    const out = await run(BALANCE, t)
    const d = draftOf(out)
    expect(d.source).toBe('ai')
    expect(d.repaired).toBe(false)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ kind: 'config', mode: 'generate', tier: 'strong', workspaceId: WS })
    expect(WireSchema.safeParse(seen[0]).success).toBe(true)
    const sent = JSON.stringify(seen[0])
    expect(sent).toContain('paid_amount')
    expect(sent).toContain('mod_fees')
    expect(sent).not.toContain('Ada') // no record contents
    expect(sent).not.toContain('st1')
    const strict = JSON.stringify(responseSchema('config'))
    expect(strict).toContain('"conditional_rule"')
    expect(strict).toContain('"dashboard"')
    expect(strict).not.toContain('"pattern"')
    expect(staticPrefix('config')).toContain('Never invent a module, field or option')
    expect(staticPrefix('config', 'repair')).toContain('REPAIR MODE')
    nothingSaved()
  })

  it('bad field and bad operator in model output are rejected, never shown as a draft, saved or run', async () => {
    const badField = { ...goodCalc, inputs: [{ field: 'total_amount' }, { field: 'discount' }] }
    const badRule: ConditionalRuleBody = { type: 'conditional_rule', name: 'x', entity: 'mod_fees', rules: [{ conditions: [{ field: 'payment_status', operator: 'greater_than', value: 5 }], action: { type: 'set_status', field: 'payment_status', value: 'Paid' } }] }
    for (const config of [badField, badRule]) {
      const before = JSON.stringify(recordsOf('mod_fees'))
      const { t, seen } = transport([{ status: 'ok', config }, { status: 'ok', config }])
      const out = await run(ODD, t)
      expect(out.kind).toBe('configure_invalid')
      if (out.kind !== 'configure_invalid') return
      expect(out.source).toBe('ai')
      expect(out.attempts).toBe(1)
      expect(out.errors.length).toBeGreaterThan(0)
      expect(out.errors.map((e) => e.message).join(' ')).toMatch(/discount|greater_than|number|date/i)
      expect(seen.map((s) => s.mode)).toEqual(['generate', 'repair']) // exactly ONE repair round
      expect(JSON.stringify(recordsOf('mod_fees'))).toBe(before)
      nothingSaved()
    }
  })

  it('the repair round feeds the errors back and a corrected answer becomes the draft', async () => {
    const bad = { ...goodCalc, inputs: [{ field: 'total_amount' }, { field: 'discount' }] }
    const { t, seen } = transport([{ status: 'ok', config: bad }, { status: 'ok', summary: 'Fixed.', config: goodCalc }])
    const events: StepEvent[] = []
    const out = await run(ODD, t, { onStep: (e) => events.push(e) })
    const d = draftOf(out)
    expect(d.source).toBe('ai')
    expect(d.repaired).toBe(true)
    expect(seen).toHaveLength(2)
    expect(seen[1]).toMatchObject({ mode: 'repair', kind: 'config' })
    expect(JSON.stringify(seen[1].variable.previous)).toContain('discount')
    expect(JSON.stringify(seen[1].variable.errors)).toMatch(/discount/)
    expect(events.map((e) => e.id)).toEqual(expect.arrayContaining(['find', 'build', 'validate', 'repair', 'preview']))
    nothingSaved()
  })

  it('model output that tries to set ownership, sharing or identity has those keys dropped', async () => {
    const dash: DashboardBody = { type: 'dashboard', name: 'Mine', widgets: [{ id: 'w1', type: 'record_count', title: 'Students', enabled: true, layout: { w: 1, h: 1, order: 0 }, source: { entity: 'mod_students', aggregation: 'count' } }], enabled: true }
    const evil = { ...dash, scope: 'workspace', userId: 'someone_else', isDefault: true, id: 'dash_hijack', ownerId: 'x' }
    const { t } = transport([{ status: 'ok', config: evil }])
    const d = draftOf(await run('Create a dashboard showing total students', t))
    expect(d.body).not.toHaveProperty('userId')
    expect(d.body).not.toHaveProperty('isDefault')
    expect(d.body).not.toHaveProperty('id')
    expect((d.body as DashboardBody).scope).toBeUndefined()
  })

  it('only a calculation, a rule or a dashboard can come out of a sentence', () => {
    expect(checkCandidate(WS, { type: 'custom_field', name: 'x', entity: 'mod_fees', field_type: 'number' }).ok).toBe(false)
    expect(checkCandidate(WS, { type: 'permission' }).ok).toBe(false)
    expect(checkCandidate(WS, 'not an object').ok).toBe(false)
    expect(checkCandidate(WS, goodCalc).ok).toBe(true)
  })

  it('the model asking a question goes through the docked question flow', async () => {
    const q = { id: 'which_paid', question: 'Which paid field did you mean?', why: 'Two fields fit', options: ['paid amount', 'paid on account'] }
    const { t } = transport([{ status: 'needs_clarification', questions: [q] }])
    const out = await run(BALANCE, t)
    expect(out.kind).toBe('clarify')
    if (out.kind !== 'clarify') return
    expect(out.questions[0].id).toBe('which_paid')
    expect(useGeniusStore.getState().memoryOf(WS).pendingQuestions.map((x) => x.id)).toEqual(['which_paid'])
  })

  it('envelope parsing: a config is required for ok, nulls from strict mode are dropped', () => {
    expect(() => parseEnvelope('config', { status: 'ok' })).toThrow()
    const ok = parseEnvelope('config', { status: 'ok', summary: 's', questions: null, config: { ...goodCalc, scope: null } })
    expect(ok.status).toBe('ok')
    expect(ok.config).toMatchObject({ type: 'calculation' })
    expect(parseEnvelope('config', { status: 'cannot_answer', summary: 'no' }).status).toBe('cannot_answer')
    expect(() => parseEnvelope('config', { status: 'needs_clarification' })).toThrow()
  })
})

describe('without an AI key it falls back to the built-in parser', () => {
  it('builds, validates and previews on real records, and saves nothing', async () => {
    const { t, seen } = transport([OFFLINE])
    const events: StepEvent[] = []
    const out = await run(BALANCE, t, { onStep: (e) => events.push(e) })
    const d = draftOf(out)
    expect(seen).toHaveLength(1) // asked once, the service said no
    expect(d.source).toBe('parser')
    expect(d.kind).toBe('calculations')
    expect(d.moduleName).toBe('Fees')
    expect(d.preview?.ok).toBe(true)
    expect(d.preview?.rows.length).toBeLessThanOrEqual(5)
    expect(d.preview?.rows.length).toBe(4)
    expect(d.preview?.rows.map((r) => r.after)).toEqual(['0', '600', '500', '800'])
    expect(d.permission.allowed).toBe(true)
    // the chat's five steps, each a real piece of work with a detail
    const ids = out.steps.filter((s) => s.status === 'done').map((s) => s.id)
    expect(ids).toEqual(expect.arrayContaining(['understand', 'find', 'build', 'validate', 'preview']))
    expect(out.steps.find((s) => s.id === 'find')?.detail).toContain('Fees')
    expect(out.steps.find((s) => s.id === 'find')?.detail).toContain('paid amount')
    expect(out.steps.find((s) => s.id === 'preview')?.detail).toContain('4 real records')
    expect(out.intent).toBe('configure')
    nothingSaved()
  })

  it('a network failure falls back the same way', async () => {
    const { t } = transport([new Error('boom')])
    expect(draftOf(await run(BALANCE, t)).source).toBe('parser')
  })

  it('an unknown field asks, and the answer is remembered and used', async () => {
    const { t } = transport([OFFLINE])
    const REQ = 'Automatically calculate remaining amount by subtracting discount from total amount'
    const out = await run(REQ, t)
    expect(out.kind).toBe('clarify')
    if (out.kind !== 'clarify') return
    const q = out.questions[0]
    expect(q.id.startsWith('nl_')).toBe(true)
    expect(q.id.length).toBeLessThanOrEqual(64)
    expect(q.options).toContain('paid amount')
    nothingSaved()
    const again = await run(REQ, t, { answers: [{ questionId: q.id, question: q.question, answer: 'paid amount', at: new Date().toISOString() }] })
    const d = draftOf(again)
    expect((d.body as CalculationBody).inputs).toEqual([{ field: 'total_amount', default: 0 }, { field: 'paid_amount', default: 0 }])
  })

  it('a request neither the model nor the parser can handle is explained, not guessed', async () => {
    const { t } = transport([OFFLINE])
    const out = await run(ODD, t)
    expect(out.kind).toBe('answer')
    if (out.kind !== 'answer') return
    expect(out.text.length).toBeGreaterThan(20)
    nothingSaved()
  })

  it('the existing flows are untouched: a plain question or an exact change is not a configuration', async () => {
    const { t, seen } = transport([OFFLINE])
    const out = await run('How is the outstanding balance calculated?', t)
    expect(out.intent).toBe('explain_calculation')
    expect(seen).toHaveLength(0)
  })
})

describe('Studio: confirm, edit, cancel', () => {
  const ask = async (text: string) => {
    mocked.transport = async () => OFFLINE
    await sendToStudio(WS, text)
    return useStudioStore.getState().sessions[WS]
  }

  it('the chat shows the steps and the draft waits in the session', async () => {
    const s = await ask(BALANCE)
    expect(s.config?.kind).toBe('calculations')
    expect(s.config?.status).toBe('draft')
    const steps = s.chat.find((c) => c.kind === 'steps')
    expect(steps && steps.kind === 'steps' && steps.steps.map((x) => x.id)).toEqual(expect.arrayContaining(['understand', 'find', 'build', 'validate', 'preview']))
    expect(s.chat.some((c) => c.kind === 'assistant' && /Nothing is saved until you press Confirm/.test(c.text))).toBe(true)
    nothingSaved()
  })

  it('Confirm persists through the engine, recalculates the real records and links to the Calculations tab', async () => {
    await ask(BALANCE)
    expect(dataOfFee('f2').remaining_amount).toBeUndefined()
    expect(await confirmConfig(WS)).toBe(true)
    const doc = engineDoc()
    expect(doc.calculations).toHaveLength(1)
    expect(doc.calculations[0]).toMatchObject({ entity: 'mod_fees', operation: 'subtract', version: 1, enabled: true })
    expect(doc.calculations[0].id).toBeTruthy()
    // executed: the stored values changed
    expect(num(dataOfFee('f1').remaining_amount)).toBe(0)
    expect(num(dataOfFee('f2').remaining_amount)).toBe(600)
    expect(num(dataOfFee('f3').remaining_amount)).toBe(500)
    expect(num(dataOfFee('f4').remaining_amount)).toBe(800)
    const s = useStudioStore.getState().sessions[WS]
    expect(s.config?.status).toBe('saved')
    const last = [...s.chat].reverse().find((c) => c.kind === 'assistant')
    expect(last && last.kind === 'assistant' && last.text).toMatch(/Saved the calculation/)
    expect(last && last.kind === 'assistant' && last.text).toMatch(/ran on 4 records/)
    expect(last && last.kind === 'assistant' && last.link).toMatchObject({ to: '/m/mod_fees', tab: 'calculations', label: 'Open Calculations' })
    // a second Confirm does nothing
    expect(await confirmConfig(WS)).toBe(false)
    expect(engineDoc().calculations).toHaveLength(1)
  })

  it('a multi-branch rule confirms, versions and executes on real records', async () => {
    const s = await ask('If paid amount is greater than or equal to total amount then set payment status to Paid. If paid amount is greater than 0 and less than total amount then set payment status to Partial. Otherwise set payment status to Pending.')
    expect(s.config?.kind).toBe('conditional_rules')
    useRecordStore.getState().setAll(schoolRecords().map((r) => (r.moduleId === 'mod_fees' ? { ...r, data: { ...r.data, payment_status: 'pending' } } : r)))
    expect(await confirmConfig(WS)).toBe(true)
    expect(engineDoc().conditional_rules).toHaveLength(1)
    expect(dataOfFee('f1').payment_status).toBe('paid')
    expect(dataOfFee('f2').payment_status).toBe('partial')
    expect(dataOfFee('f3').payment_status).toBe('pending')
    expect(dataOfFee('f4').payment_status).toBe('pending')
    const last = [...useStudioStore.getState().sessions[WS].chat].reverse().find((c) => c.kind === 'assistant')
    expect(last && last.kind === 'assistant' && last.link).toMatchObject({ to: '/m/mod_fees', tab: 'rules' })
  })

  it('a dashboard confirms as the person\'s own dashboard and links to the Dashboards page', async () => {
    const s = await ask('create a dashboard showing total students, paid fees, unpaid fees, average attendance and students with attendance below 75%')
    expect(s.config?.kind).toBe('dashboards')
    expect(s.config?.widgets).toEqual({ total: 5, computed: 5 })
    expect(await confirmConfig(WS)).toBe(true)
    const uid = useSettingsStore.getState().settings.currentUserId
    const mine = visibleDashboards(engineDoc().dashboards, uid).find((d) => d.widgets.length === 5)
    expect(mine).toMatchObject({ scope: 'user', userId: uid, name: 'Dashboard' })
    const last = [...useStudioStore.getState().sessions[WS].chat].reverse().find((c) => c.kind === 'assistant')
    expect(last && last.kind === 'assistant' && last.link).toMatchObject({ to: '/dashboards', dashboardId: mine?.id })
  })

  it('Cancel drops the draft and changes nothing', async () => {
    await ask(BALANCE)
    cancelConfig(WS)
    const s = useStudioStore.getState().sessions[WS]
    expect(s.config).toBeNull()
    expect(s.chat.some((c) => c.kind === 'assistant' && /Cancelled/.test(c.text))).toBe(true)
    expect(await confirmConfig(WS)).toBe(false)
    nothingSaved()
  })

  it('Edit opens the editor with the draft loaded (module page) without saving', async () => {
    await ask(BALANCE)
    const to = editConfig(WS)
    expect(to).toBe('/m/mod_fees')
    const nav = useConfigNav.getState().module
    expect(nav).toMatchObject({ moduleId: 'mod_fees', tab: 'calculations' })
    expect(nav?.body).toMatchObject({ type: 'calculation', operation: 'subtract' })
    nothingSaved()
  })

  it('Edit on a dashboard saves it as the person\'s own and selects it for the builder', async () => {
    await ask('create a dashboard showing total students and average attendance')
    expect(editConfig(WS)).toBe('/dashboards')
    const id = useConfigNav.getState().dashboard?.dashboardId
    expect(id).toBeTruthy()
    expect(useSelectionStore.getState().dashboardId).toBe(id)
    expect(engineDoc().dashboards.find((d) => d.id === id)?.widgets).toHaveLength(2)
  })

  it('a question about which field is never answered by guessing, and Skip stops instead of picking', async () => {
    const s = await ask('Automatically calculate remaining amount by subtracting discount from total amount')
    expect(s.asking?.length).toBe(1)
    expect(s.configuring).toBe(true)
    expect(s.config).toBeNull()
    skipAsked(WS)
    const after = useStudioStore.getState().sessions[WS]
    expect(after.asking).toBeNull()
    expect(after.config).toBeNull()
    nothingSaved()
  })

  it('a bad model answer is shown in the chat as errors, with nothing saved', async () => {
    mocked.transport = async () => okRes({ status: 'ok', config: { ...goodCalc, inputs: [{ field: 'total_amount' }, { field: 'discount' }] } })
    await sendToStudio(WS, ODD)
    const s = useStudioStore.getState().sessions[WS]
    expect(s.config).toBeNull()
    const msg = s.chat.filter((c) => c.kind === 'assistant').map((c) => (c.kind === 'assistant' ? c.text : '')).join('\n')
    expect(msg).toMatch(/could not complete this/)
    expect(msg).toMatch(/discount/)
    nothingSaved()
  })
})

describe('permissions', () => {
  it('a viewer sees the draft and the reason, and Confirm / Edit refuse to save', async () => {
    resetWorld({ roleId: 'role_viewer' })
    putModules(...schoolModules())
    useRecordStore.getState().setAll(schoolRecords())
    mocked.transport = async () => OFFLINE
    await sendToStudio(WS, BALANCE)
    const s = useStudioStore.getState().sessions[WS]
    expect(s.config?.permission.allowed).toBe(false)
    expect(s.config?.permission.message).toMatch(/not allowed to change calculations/)
    expect(s.chat.some((c) => c.kind === 'assistant' && /not allowed to change calculations/.test(c.text))).toBe(true)
    expect(await confirmConfig(WS)).toBe(false)
    expect(editConfig(WS)).toBeNull()
    expect(useStudioStore.getState().sessions[WS].chat.some((c) => c.kind === 'assistant' && c.tone === 'error' && /Nothing was saved/.test(c.text))).toBe(true)
    nothingSaved()
  })

  it('the engine itself refuses a draft that was built for someone else (defence in depth)', async () => {
    const { t } = transport([OFFLINE])
    const d = draftOf(await run(BALANCE, t)) // built as the owner
    resetWorld({ roleId: 'role_viewer' })
    putModules(...schoolModules())
    const r = await confirmDraft({ ...d, permission: { allowed: true } })
    expect(r.ok).toBe(false)
    expect(r.errors[0].path).toBe('(permission)')
    nothingSaved()
  })

  it('a manager may confirm a rule or a dashboard but not a calculation', async () => {
    resetWorld({ roleId: 'role_manager' })
    putModules(...schoolModules())
    useRecordStore.getState().setAll(schoolRecords())
    mocked.transport = async () => OFFLINE
    await sendToStudio(WS, BALANCE)
    expect(useStudioStore.getState().sessions[WS].config?.permission.allowed).toBe(false)
    await sendToStudio(WS, 'If paid amount is 0 then set payment status to Pending')
    const s = useStudioStore.getState().sessions[WS]
    expect(s.config?.kind).toBe('conditional_rules')
    expect(s.config?.permission.allowed).toBe(true)
    expect(await confirmConfig(WS)).toBe(true)
    expect(engineDoc().conditional_rules).toHaveLength(1)
  })
})

const dataOfFee = (id: string) => recordsOf('mod_fees').find((r) => r.id === id)!.data as Record<string, unknown>
const num = (v: unknown) => (v && typeof v === 'object' && 'toNumber' in v ? (v as { toNumber(): number }).toNumber() : Number(v))
