import { readFileSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { projectIdFor } from '#/genius/compiler/ids'
import { applyProposal } from '#/genius/service/actions'
import { submitProposal } from '#/genius/service/builder'
import { buildDefaultDashboard, ensureDefaultDashboard } from '#/engine/defaultDashboard'
import { dueScheduled, graphFor, recalculateModule, recalculateProject, resetSchedulerSession, runDueSchedules, runEngineBatch, startEngine, stopEngine } from '#/engine/runtime'
import { saveConfig, validationEnvFor } from '#/engine/service'
import { paymentStatusRule } from '#/engine/rules'
import { useEngineStatus } from '#/engine/status'
import type { CalculationBody, ConditionalRuleBody } from '#/engine/schema'
import { normalizeDoc } from '#/engine/schema'
import { validateConfig } from '#/engine/validate'
import { handleRecordEvent } from '#/services/workflowEngine'
import { createWorkspace } from '#/services/workspaceService'
import { parseDocs, serializeDocs } from '#/services/storage/engineStorage'
import { useDashboardStore, useRunStore, useWorkflowStore } from '#/stores/collections'
import { useEngineStore } from '#/stores/engineStore'
import { useModuleStore } from '#/stores/moduleStore'
import { useRecordStore } from '#/stores/recordStore'
import { useWorkspaceStore } from '#/stores/workspaceStore'
import { onRecordEvent } from '#/utils/events'
import type { Workflow } from '#/types'
import { dataOf, feesModule, field, mod, paymentsModule, putModules, recordsOf, studentsModule } from './engine-fixtures'
import { resetWorld, TENANT, WS } from './helpers'

const fld = (f: string, d?: number) => ({ field: f, default: d })
const val = (n: number | string) => ({ value: n })
const calcBody = (over: Partial<CalculationBody>): CalculationBody => ({ type: 'calculation', name: 'c', entity: 'mod_fees', operation: 'add', scope: 'record', ...over }) as CalculationBody
const remainingCalc = () => calcBody({ name: 'Remaining', output_field: 'remaining_amount', operation: 'subtract', inputs: [fld('total_amount', 0), fld('paid_amount', 0)] })
const save = (body: unknown) => {
  const r = saveConfig(WS, body, { role: null })
  if (!r.ok) throw new Error(JSON.stringify(r.errors))
  return r.item!
}
const rs = () => useRecordStore.getState()
const statusKeys = () => Object.keys(useEngineStatus.getState().status).filter((k) => k !== '__engine').sort()

/** engine writes: record updates whose chain ends with an engine marker */
function watchEngineWrites() {
  const seen: { id: string; keys: string[] }[] = []
  const off = onRecordEvent((e) => {
    if (e.type === 'updated' && e.chain?.at(-1)?.startsWith('engine:')) seen.push({ id: e.record.id, keys: Object.keys(e.record.data).filter((k) => JSON.stringify(e.record.data[k]) !== JSON.stringify(e.previous?.data[k])) })
  })
  return { seen, off }
}

beforeAll(() => startEngine())
afterAll(() => stopEngine())
beforeEach(() => {
  resetWorld()
  resetSchedulerSession()
})

describe('recordStore -> engine: fees', () => {
  beforeEach(() => {
    putModules(feesModule())
    save(remainingCalc())
    save(paymentStatusRule('mod_fees'))
    useEngineStatus.getState().clear()
  })

  it('create + update: remaining_amount and payment_status follow paid_amount', () => {
    const id = rs().create('mod_fees', { total_amount: 1000 }).record!.id
    expect(dataOf(id).remaining_amount).toBe(1000)
    expect(dataOf(id).payment_status).toBe('pending')
    rs().update(id, { paid_amount: 400 })
    expect(dataOf(id).remaining_amount).toBe(600)
    expect(dataOf(id).payment_status).toBe('partial')
    rs().update(id, { paid_amount: 1000 })
    expect(dataOf(id).remaining_amount).toBe(0)
    expect(dataOf(id).payment_status).toBe('paid')
    rs().update(id, { total_amount: 1500 })
    expect(dataOf(id).remaining_amount).toBe(500)
    expect(dataOf(id).payment_status).toBe('partial')
  })

  it('the output field was created as a stored, calculated, read-only field', () => {
    putModules(mod('mod_fees', 'Fees', [field('total_amount', 'currency'), field('paid_amount', 'currency'), field('payment_status', 'dropdown', { options: [{ id: 'paid', label: 'Paid' }, { id: 'partial', label: 'Partial' }, { id: 'pending', label: 'Pending' }] })]))
    save(calcBody({ name: 'Left', output_field: 'amount_left', operation: 'subtract', inputs: [fld('total_amount', 0), fld('paid_amount', 0)] }))
    const f = useModuleStore.getState().modules[0].fields.find((x) => x.name === 'amount_left')!
    expect(f).toMatchObject({ type: 'currency', calculated: true, readOnly: true })
    const id = rs().create('mod_fees', { total_amount: 5, paid_amount: 2 }).record!.id
    expect(dataOf(id)[f.id]).toBe(3)
  })

  it('writes every result of an edit in ONE batched update and skips unchanged values', () => {
    const id = rs().create('mod_fees', { total_amount: 1000 }).record!.id
    const w = watchEngineWrites()
    rs().update(id, { paid_amount: 400 })
    expect(w.seen).toHaveLength(1)
    expect(w.seen[0].keys.sort()).toEqual(['payment_status', 'remaining_amount'])
    w.seen.length = 0
    rs().update(id, { notes: 'called the parent' }) // nothing it reads changed
    rs().update(id, { paid_amount: 400 }) // same value: no change event at all
    expect(w.seen).toHaveLength(0)
    rs().update(id, { paid_amount: 450 }) // status stays Partial: only remaining changes
    expect(w.seen).toHaveLength(1)
    expect(w.seen[0].keys).toEqual(['remaining_amount'])
    w.off()
  })

  it('only the configs that read a changed field run', () => {
    save(calcBody({ name: 'Days late', output_field: 'days_late', operation: 'date_diff', inputs: [fld('due_date'), val('today')] }))
    const [late, remaining, status] = [useEngineStore.getState().docOf(WS).calculations.find((c) => c.name === 'Days late')!, useEngineStore.getState().docOf(WS).calculations.find((c) => c.name === 'Remaining')!, useEngineStore.getState().docOf(WS).conditional_rules[0]]
    const id = rs().create('mod_fees', { total_amount: 100, due_date: '2026-01-01' }).record!.id
    useEngineStatus.getState().clear()
    rs().update(id, { notes: 'x' })
    expect(statusKeys()).toEqual([])
    rs().update(id, { due_date: '2026-02-01' })
    expect(statusKeys()).toEqual([late.id])
    useEngineStatus.getState().clear()
    rs().update(id, { paid_amount: 10 })
    expect(statusKeys()).toEqual([remaining.id, status.id].sort())
    expect(useEngineStatus.getState().status[late.id]).toBeUndefined()
  })

  it('a rule that undoes itself cannot ping-pong: the engine write does not re-trigger the engine', () => {
    const flip: ConditionalRuleBody = { type: 'conditional_rule', name: 'Flip', entity: 'mod_fees', mode: 'all', rules: [{ conditions: [{ field: 'notes', operator: 'equal', value: 'a' }], action: { type: 'update_field', field: 'notes', value: 'b' } }, { conditions: [{ field: 'notes', operator: 'equal', value: 'b' }], action: { type: 'update_field', field: 'notes', value: 'a' } }] }
    save(flip)
    const w = watchEngineWrites()
    const id = rs().create('mod_fees', { total_amount: 1, notes: 'a' }).record!.id
    expect(dataOf(id).notes).toBe('b')
    expect(w.seen.filter((s) => s.keys.includes('notes'))).toHaveLength(1)
    w.off()
  })

  it('circular configs that bypass validation never run and never hang', () => {
    const a = calcBody({ name: 'A', output_field: 'a_out', operation: 'add', inputs: [fld('b_out', 0), val(1)] })
    const b = calcBody({ name: 'B', output_field: 'b_out', operation: 'add', inputs: [fld('a_out', 0), val(1)] })
    useEngineStore.getState().add(WS, 'calculations', a)
    useEngineStore.getState().add(WS, 'calculations', b)
    const g = graphFor(WS)
    expect(g.cycle).not.toBeNull()
    expect(g.order.map((n) => n.name)).not.toContain('A')
    expect(g.order.map((n) => n.name)).not.toContain('B')
    const id = rs().create('mod_fees', { total_amount: 10 }).record!.id
    expect(dataOf(id).remaining_amount).toBe(10)
    expect(dataOf(id).a_out).toBeUndefined()
    expect(dataOf(id).b_out).toBeUndefined()
  })

  it('a workflow that feeds the engine back is bounded by the shared loop guard', async () => {
    const wf: Workflow = { id: 'wf_feedback', workspaceId: WS, moduleId: 'mod_fees', name: 'Feedback', enabled: true, origin: 'manual', trigger: { type: 'field_changed', fieldId: 'remaining_amount' }, conditions: [], actions: [{ id: 'a1', type: 'update_record', fieldId: 'paid_amount', value: 500 }], createdAt: '', updatedAt: '' }
    useWorkflowStore.getState().add(wf)
    const off = onRecordEvent(handleRecordEvent)
    const id = rs().create('mod_fees', { total_amount: 1000 }).record!.id
    off()
    // engine -> workflow -> engine: the workflow's write goes through, but configs already in the chain do not re-enter it
    expect(dataOf(id).paid_amount).toBe(500)
    expect(dataOf(id).remaining_amount).toBe(1000)
    expect(useRunStore.getState().runs.length).toBeLessThan(10)
    // the next explicit recalculation settles the data
    await recalculateModule('mod_fees', { yieldFn: async () => {} })
    expect(dataOf(id).remaining_amount).toBe(500)
  })

  it('run_automation runs an existing workflow for the record', () => {
    const wf: Workflow = { id: 'wf_note', workspaceId: WS, moduleId: 'mod_fees', name: 'Note', enabled: true, origin: 'manual', trigger: { type: 'manual' } as never, conditions: [], actions: [{ id: 'a1', type: 'update_record', fieldId: 'notes', value: 'paid in full' }], createdAt: '', updatedAt: '' }
    useWorkflowStore.getState().add(wf)
    save({ type: 'conditional_rule', name: 'Close', entity: 'mod_fees', rules: [{ conditions: [{ field: 'payment_status', operator: 'equal', value: 'Paid' }], action: { type: 'run_automation', workflow_id: 'wf_note' } }] })
    const id = rs().create('mod_fees', { total_amount: 10, paid_amount: 10 }).record!.id
    expect(dataOf(id).notes).toBe('paid in full')
  })
})

describe('related records cascade', () => {
  beforeEach(() => {
    putModules(studentsModule(), paymentsModule())
    const base = { type: 'calculation', entity: 'mod_students', scope: 'record', related: { entity: 'mod_payments', via: 'student' } }
    save({ ...base, name: 'Total paid', output_field: 'total_paid', operation: 'sum', inputs: [fld('amount')] })
    save({ ...base, name: 'Payment count', output_field: 'payment_count', operation: 'count' })
  })
  const student = (name = 'Ada') => rs().create('mod_students', { full_name: name }).record!.id
  const pay = (s: string, amount: number) => rs().create('mod_payments', { student: s, amount }).record!.id

  it('parents are recalculated when children are created, edited, moved, deleted and restored', () => {
    const a = student('Ada')
    const b = student('Bo')
    const p1 = pay(a, 0.1)
    pay(a, 0.2)
    expect(dataOf(a).total_paid).toBe(0.3) // exact decimals
    expect(dataOf(a).payment_count).toBe(2)
    rs().update(p1, { amount: 10 })
    expect(dataOf(a).total_paid).toBe(10.2)
    rs().update(p1, { student: b })
    expect(dataOf(a).total_paid).toBe(0.2)
    expect(dataOf(b).total_paid).toBe(10)
    expect(dataOf(b).payment_count).toBe(1)
    rs().softDelete([p1])
    expect(dataOf(b).total_paid).toBe(0)
    expect(dataOf(b).payment_count).toBe(0)
    rs().restore([p1])
    expect(dataOf(b).total_paid).toBe(10)
    rs().archive([p1], true)
    expect(dataOf(b).total_paid).toBe(0)
    rs().archive([p1], false)
    rs().softDelete([p1])
    rs().purge([p1])
    expect(dataOf(b).total_paid).toBe(0)
  })

  it('an unrelated edit does not touch the parent', () => {
    const a = student()
    const p = pay(a, 5)
    const before = rs().records.find((r) => r.id === a)!.updatedAt
    rs().update(p, { method: 'cash' })
    expect(rs().records.find((r) => r.id === a)!.updatedAt).toBe(before)
  })

  it('an import is one pass: each parent is written once', () => {
    const a = student()
    const w = watchEngineWrites()
    runEngineBatch(() => {
      for (let i = 0; i < 25; i++) pay(a, 1)
    })
    expect(dataOf(a).total_paid).toBe(25)
    expect(dataOf(a).payment_count).toBe(25)
    expect(w.seen.filter((s) => s.id === a)).toHaveLength(1)
    w.off()
  })
})

describe('recalculate now', () => {
  it('recalculates a module in chunks with progress, and collects per-record errors', async () => {
    putModules(feesModule())
    // records written silently: the engine has not seen them
    const ids = Array.from({ length: 7 }, (_, i) => rs().create('mod_fees', { total_amount: 100 + i, paid_amount: 100 }, { silent: true }).record!.id)
    save(remainingCalc())
    expect(dataOf(ids[0]).remaining_amount).toBe("")
    const steps: number[] = []
    const report = await recalculateModule('mod_fees', { chunkSize: 3, onProgress: (p) => steps.push(p.done), yieldFn: async () => {} })
    expect(report).toMatchObject({ processed: 7, errors: [], cancelled: false })
    expect(steps).toEqual([3, 6, 7])
    expect(dataOf(ids[6]).remaining_amount).toBe(6)
    expect(report.written).toBe(7)
    // a second run changes nothing
    expect((await recalculateModule('mod_fees', { yieldFn: async () => {} })).written).toBe(0)

    // a broken rule (bypassing validation) reports one error per record and does not stop the others
    useEngineStore.getState().add(WS, 'conditional_rules', { type: 'conditional_rule', name: 'Broken', entity: 'mod_fees', rules: [{ conditions: [], action: { type: 'set_status', field: 'payment_status', value: 'Nonsense' } }] })
    const bad = await recalculateModule('mod_fees', { yieldFn: async () => {} })
    expect(bad.errors).toHaveLength(7)
    expect(bad.errors[0].message).toMatch(/not an option/)
    expect(useEngineStatus.getState().status[useEngineStore.getState().docOf(WS).conditional_rules[0].id].ok).toBe(false)
  })

  it('can be cancelled between chunks, and recalculateProject follows dependency order', async () => {
    putModules(studentsModule(), paymentsModule())
    const base = { type: 'calculation', entity: 'mod_students', scope: 'record', related: { entity: 'mod_payments', via: 'student' } }
    save({ ...base, name: 'Total paid', output_field: 'total_paid', operation: 'sum', inputs: [fld('amount')] })
    const s = rs().create('mod_students', { full_name: 'A' }).record!.id
    rs().create('mod_payments', { student: s, amount: 5 }, { silent: true })
    const ctl = { aborted: false }
    const cancelled = await recalculateProject(WS, { chunkSize: 1, signal: ctl, onProgress: () => { ctl.aborted = true }, yieldFn: async () => {} })
    expect(cancelled.cancelled).toBe(false) // one record only: finished before the check
    const full = await recalculateProject(WS, { yieldFn: async () => {} })
    expect(full.modules).toEqual(['mod_students'])
    expect(dataOf(s).total_paid).toBe(5)
  })

  it('manual calculations only run when asked; scheduled ones run once per period while the app is open', async () => {
    putModules(feesModule())
    save(calcBody({ name: 'Manual', output_field: 'remaining_amount', operation: 'subtract', inputs: [fld('total_amount', 0), fld('paid_amount', 0)], trigger: 'manual' }))
    const id = rs().create('mod_fees', { total_amount: 100 }).record!.id
    expect(dataOf(id).remaining_amount).toBe("")
    await recalculateModule('mod_fees', { yieldFn: async () => {} })
    expect(dataOf(id).remaining_amount).toBe(100)

    save(calcBody({ name: 'Nightly', output_field: 'days_open', operation: 'date_diff', inputs: [val('2026-01-01'), val('today')], trigger: 'schedule', schedule: 'daily' }))
    const day1 = new Date('2026-03-15T09:00:00')
    expect(dueScheduled(day1)).toHaveLength(1)
    const reports = await runDueSchedules(day1, { yieldFn: async () => {} })
    expect(reports).toHaveLength(1)
    expect(dueScheduled(day1)).toHaveLength(0) // saved before running: no repeat
    expect(dueScheduled(new Date('2026-03-15T23:00:00'))).toHaveLength(0)
    expect(dueScheduled(new Date('2026-03-16T08:00:00'))).toHaveLength(1)
    const daysOpen = useModuleStore.getState().modules[0].fields.find((x) => x.name === 'days_open')!
    expect(dataOf(id)[daysOpen.id]).toBeGreaterThan(0)
  })
})

// ---- default dashboard -----------------------------------------------------------------------------------------

const blueprint = () => {
  const bp = JSON.parse(readFileSync(new URL('./fixtures/ai-letting-blueprint.json', import.meta.url), 'utf8'))
  bp.meta.projectId = projectIdFor(TENANT, WS)
  bp.meta.revisionId = 'rev_none'
  for (const r of bp.relationships) r.deletePolicy = 'restrict'
  for (const r of bp.roles) r.grants = r.grants.filter((g: string) => g !== 'accessSettings')
  return bp
}

describe('default "Overview" dashboard', () => {
  it('is built from the real modules and fields, and passes the validator', () => {
    putModules(studentsModule(), paymentsModule(), feesModule())
    const d = buildDefaultDashboard(WS, useModuleStore.getState().modules)
    const types = d.widgets.map((w) => w.type)
    expect(d.name).toBe('Overview')
    expect(types.filter((t) => t === 'record_count')).toHaveLength(3)
    expect(types).toEqual(expect.arrayContaining(['kpi', 'average', 'status_breakdown', 'recent_records', 'line_chart']))
    const sum = d.widgets.find((w) => w.type === 'kpi')!
    expect(sum.source).toMatchObject({ aggregation: 'sum' })
    expect(sum.format).toMatchObject({ kind: 'currency' })
    const res = validateConfig(d, validationEnvFor(WS, { role: null }))
    expect(res.errors).toEqual([])
  })

  it('every new project gets it: blank, Studio publish, and the lazy path; calling again changes nothing', () => {
    resetWorld()
    const blank = createWorkspace({ name: 'Blank one', kind: 'project', switchTo: false })
    const blankDash = useEngineStore.getState().docOf(blank.id).dashboards
    expect(blankDash).toHaveLength(1)
    expect(blankDash[0]).toMatchObject({ name: 'Overview', isDefault: true, autoManaged: true, scope: 'workspace', workspaceId: blank.id })
    expect(blankDash[0].widgets).toEqual([])

    const { proposal, outcome } = submitProposal(WS, { kind: 'build', raw: blueprint(), request: 'x', intent: 'new_build' })
    expect(outcome.report.errors).toEqual([])
    const r = applyProposal(proposal.id) as { ok: boolean; workspaceId?: string }
    expect(r.ok).toBe(true)
    const ws = r.workspaceId!
    const doc = useEngineStore.getState().docOf(ws)
    expect(doc.dashboards).toHaveLength(1)
    const mods = useModuleStore.getState().modules.filter((m) => m.workspaceId === ws && !m.archived && !m.system)
    const counts = doc.dashboards[0].widgets.filter((w) => w.type === 'record_count')
    expect(counts.length).toBe(Math.min(6, mods.length))
    for (const w of counts) expect(mods.some((m) => m.id === w.source!.entity)).toBe(true)
    expect(validateConfig(doc.dashboards[0], validationEnvFor(ws, { role: null })).errors).toEqual([])
    // the existing Dashboards page (legacy collection) shows the same overview
    const legacy = useDashboardStore.getState().items.filter((d) => d.workspaceId === ws)
    expect(legacy).toHaveLength(1)
    expect(legacy[0].widgets.length).toBeGreaterThan(0)

    ensureDefaultDashboard(ws)
    ensureDefaultDashboard(ws)
    expect(useEngineStore.getState().docOf(ws).dashboards).toHaveLength(1)
    expect(useDashboardStore.getState().items.filter((d) => d.workspaceId === ws)).toHaveLength(1)

    // lazy path: a workspace that has none gets one when its dashboard page opens
    useEngineStore.getState().removeByWorkspace(ws)
    expect(useEngineStore.getState().docOf(ws).dashboards).toHaveLength(0)
    ensureDefaultDashboard(ws)
    expect(useEngineStore.getState().docOf(ws).dashboards).toHaveLength(1)
    expect(useWorkspaceStore.getState().workspaces.some((w) => w.id === ws)).toBe(true)
  })

  it('an auto-managed overview follows new modules; an edited one is left alone', () => {
    putModules(studentsModule())
    const id = ensureDefaultDashboard(WS)
    expect(useEngineStore.getState().get(WS, 'dashboards', id)!.widgets.filter((w) => w.type === 'record_count')).toHaveLength(1)
    putModules(studentsModule(), paymentsModule())
    ensureDefaultDashboard(WS)
    expect(useEngineStore.getState().get(WS, 'dashboards', id)!.widgets.filter((w) => w.type === 'record_count')).toHaveLength(2)
    useEngineStore.getState().saveDashboardFor(WS, 'usr_owner', id, { widgets: [] })
    putModules(studentsModule(), paymentsModule(), feesModule())
    ensureDefaultDashboard(WS)
    expect(useEngineStore.getState().get(WS, 'dashboards', id)!.widgets.filter((w) => w.type === 'record_count')).toHaveLength(3)
    expect(useEngineStore.getState().activeDashboardFor(WS, 'usr_owner')!.widgets).toEqual([])
  })
})

describe('per-user dashboards and the engine store', () => {
  afterEach(() => useEngineStore.getState().setAll([]))

  it('two users see different layouts, and they survive a save/load round trip', () => {
    putModules(studentsModule(), paymentsModule(), feesModule())
    const shared = ensureDefaultDashboard(WS)
    const all = useEngineStore.getState().get(WS, 'dashboards', shared)!.widgets
    const store = useEngineStore.getState()
    const mine = store.saveDashboardFor(WS, 'u1', shared, { widgets: all.slice(0, 2) })!
    const theirs = store.saveDashboardFor(WS, 'u2', shared, { widgets: [{ ...all[0], title: 'Renamed for u2' }] })!
    expect(mine.scope).toBe('user')
    expect(mine.userId).toBe('u1')
    expect(mine.baseId).toBe(shared)
    expect(mine.id).not.toBe(theirs.id)
    // a second save updates the user's own copy in place and bumps its version
    const again = useEngineStore.getState().saveDashboardFor(WS, 'u1', mine.id, { name: 'Mine' })!
    expect(again.id).toBe(mine.id)
    expect(again.version).toBe(mine.version + 1)

    const view = (u: string) => useEngineStore.getState().activeDashboardFor(WS, u)!
    expect(view('u1').widgets).toHaveLength(2)
    expect(view('u2').widgets[0].title).toBe('Renamed for u2')
    expect(view('u3').id).toBe(shared) // a user without one gets the default
    expect(useEngineStore.getState().get(WS, 'dashboards', shared)!.widgets).toEqual(all)

    const json = serializeDocs(useEngineStore.getState().docs)
    useEngineStore.getState().setAll([])
    expect(useEngineStore.getState().activeDashboardFor(WS, 'u1')).toBeUndefined()
    useEngineStore.getState().setAll(parseDocs(json))
    expect(view('u1').widgets).toHaveLength(2)
    expect(view('u1').name).toBe('Mine')
    expect(view('u2').widgets[0].title).toBe('Renamed for u2')
    expect(view('u3').id).toBe(shared)

    useEngineStore.getState().resetDashboardFor(WS, 'u1', shared)
    expect(view('u1').id).toBe(shared)
  })

  it('CRUD bumps version and updatedAt; a disabled config is kept but not used; storage parsing is defensive', () => {
    putModules(feesModule())
    const item = save(remainingCalc())
    expect(item).toMatchObject({ version: 1, enabled: true, workspaceId: WS, ownerId: 'usr_owner', type: 'calculation' })
    const next = useEngineStore.getState().update(WS, 'calculations', item.id, { name: 'Renamed' })!
    expect(next.version).toBe(2)
    expect(next.createdAt).toBe(item.createdAt)
    expect(next.updatedAt >= item.updatedAt).toBe(true)
    useEngineStore.getState().setEnabled(WS, 'calculations', item.id, false)
    expect(graphFor(WS).nodes).toHaveLength(0)
    expect(parseDocs('not json')).toEqual([])
    expect(parseDocs([{ id: 'a', calculations: 'nope' }, { id: 'a' }, { nope: 1 }])).toHaveLength(1)
    expect(normalizeDoc({ id: 'x', calculations: [{ id: 'c1' }, 5] }).calculations).toHaveLength(1)
    expect(recordsOf('mod_fees')).toHaveLength(0)
  })
})
