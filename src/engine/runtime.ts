import { isSameDay } from 'date-fns'
import type { CrmRecord, Module } from '#/types'
import { executeWorkflow } from '#/services/workflowEngine'
import { useEngineStore } from '#/stores/engineStore'
import { useModuleStore } from '#/stores/moduleStore'
import { useRecordStore } from '#/stores/recordStore'
import { useWorkflowStore } from '#/stores/collections'
import { onRecordEvent, onRecordLifecycle, type RecordEvent, type RecordLifecycle } from '#/utils/events'
import { toIds } from '#/utils/records'
import { outputFieldFor, runCalculation, sameValue, scopeOf, toStored } from './calc'
import { buildGraph, keyOf, MAX_ENGINE_DEPTH, MAX_ENGINE_ITEMS, relLinks, usesClock, type DepNode, type Graph, type RelLink } from './dependencies'
import { evaluateRule } from './rules'
import { EngineError, isLive, makeEnv, resolveField, resolveModule } from './resolve'
import type { Calculation, ConditionalRule } from './schema'
import { useEngineStatus, type ConfigStatus } from './status'

/**
 * Automatic recalculation.
 *
 * HOOK. recordStore emits created / updated / deleted events (and archive / restore / purge lifecycle events); this module
 * listens and runs ONLY the calculations and rules whose input fields changed, in dependency order, writing all
 * results of one record in ONE recordStore.update (unchanged values are skipped, so a re-run never writes or loops).
 * Results that other records aggregate (a student's total of payments) cascade to those parents.
 *
 * LOOP GUARDS (coordinated with services/workflowEngine):
 *  - engine writes carry `engine:<configId>` in the write chain. The listener ignores events whose LAST chain entry is an
 *    engine marker (the cascade already ran in-process); events that a workflow produced in response (chain ends with the
 *    workflow id) are processed, but a config whose marker is already in the chain is skipped (it is what started it).
 *  - workflows triggered by engine writes run with depth + 1, so workflowEngine's MAX_CASCADE_DEPTH applies to the whole chain.
 *  - cascades are capped at MAX_ENGINE_DEPTH levels and MAX_ENGINE_ITEMS records per run.
 *  - circular configurations are refused at save time (dependencies.ts); nodes that are in a cycle anyway never run.
 *
 * Scope: runs in the open browser tab (like the workflow engine). There is no background server.
 */

export interface RecalcError {
  recordId: string
  moduleId: string
  configId?: string
  message: string
}

interface Job {
  recordId: string
  moduleId: string
  /** qualified keys (`moduleId.fieldId`) that changed */
  changed: Set<string>
  kind: 'created' | 'updated' | 'deleted' | 'touch'
  /** cascade level: 0 = the edited record */
  level: number
  /** workflow recursion depth of the event that started this */
  depth: number
  chain: string[]
  prev?: CrmRecord
  /** the record as the event saw it (needed when it no longer exists / is no longer live) */
  snapshot?: CrmRecord
  /** the record left the live set: only its parents are recalculated */
  skipSelf?: boolean
  /** recalculate: run every config (or those in `only`) regardless of what changed */
  force?: boolean
  only?: Set<string>
}

const queue = new Map<string, Job>()
let draining = false
let batchDepth = 0

interface Collector {
  errors: RecalcError[]
  processed: number
  written: number
}
let collector: Collector | null = null
const pending = new Map<string, { records: number; writes: number; error?: string }>()

const note = (id: string, d: { records?: number; writes?: number; error?: string }) => {
  const p = pending.get(id) ?? { records: 0, writes: 0 }
  p.records += d.records ?? 0
  p.writes += d.writes ?? 0
  if (d.error) p.error = d.error
  pending.set(id, p)
}

function flushStatus() {
  if (!pending.size) return
  const prev = useEngineStatus.getState().status
  const at = new Date().toISOString()
  const patch: Record<string, ConfigStatus> = {}
  for (const [id, p] of pending) patch[id] = { lastRunAt: at, ok: !p.error, error: p.error, records: (prev[id]?.records ?? 0) + p.records, writes: (prev[id]?.writes ?? 0) + p.writes }
  pending.clear()
  useEngineStatus.getState().merge(patch)
}

// ---- graph -----------------------------------------------------------------------------------------------------

const graphCache = new Map<string, { calcs: Calculation[]; rules: ConditionalRule[]; modules: Module[]; graph: Graph }>()
const linkCache = new WeakMap<Graph, Map<string, RelLink[]>>()

/** The dependency graph of a workspace's enabled calculations and rules (cached until configs or modules change). */
export function graphFor(ws: string, modules = useModuleStore.getState().modules): Graph {
  const doc = useEngineStore.getState().docOf(ws)
  const hit = graphCache.get(ws)
  if (hit && hit.calcs === doc.calculations && hit.rules === doc.conditional_rules && hit.modules === modules) return hit.graph
  const wsModules = modules.filter((m) => m.workspaceId === ws)
  const graph = buildGraph(
    [...doc.calculations.filter((c) => c.enabled).map((config) => ({ kind: 'calculation' as const, config })), ...doc.conditional_rules.filter((r) => r.enabled).map((config) => ({ kind: 'rule' as const, config }))],
    wsModules,
  )
  graphCache.set(ws, { calcs: doc.calculations, rules: doc.conditional_rules, modules, graph })
  return graph
}

function linksOf(graph: Graph, modules: Module[]): Map<string, RelLink[]> {
  let m = linkCache.get(graph)
  if (!m) {
    m = new Map()
    for (const n of graph.nodes) if (n.kind === 'calculation') m.set(n.id, relLinks(n.config as Calculation, modules))
    linkCache.set(graph, m)
  }
  return m
}

const allKeys = (m: Module): Set<string> => new Set([...m.fields.map((f) => keyOf(m.id, f.id)), keyOf(m.id, '__createdAt'), keyOf(m.id, '__updatedAt')])
const intersects = (a: Set<string>, b: Set<string>): boolean => {
  for (const x of a) if (b.has(x)) return true
  return false
}

/** Create the stored, calculated, read-only output field of every enabled per-record calculation that does not have one yet. */
export function ensureOutputFields(ws: string): number {
  const doc = useEngineStore.getState().docOf(ws)
  let created = 0
  for (const calc of doc.calculations) {
    if (!calc.enabled || scopeOf(calc) !== 'record' || !calc.output_field) continue
    const modules = useModuleStore.getState().modules
    const module = resolveModule(modules.filter((m) => m.workspaceId === ws), calc.entity)
    if (!module || resolveField(module, calc.output_field)) continue
    const { field } = outputFieldFor(calc, module, makeEnv(modules, []))
    useModuleStore.getState().addField(module.id, field)
    created++
  }
  return created
}

// ---- running one record ----------------------------------------------------------------------------------------

const autoTrigger = (n: DepNode, job: Job): boolean => {
  if (n.kind === 'calculation') {
    const c = n.config as Calculation
    return (c.trigger ?? 'on_record_change') === 'on_record_change' && c.auto_update !== false
  }
  const t = (n.config as ConditionalRule).trigger ?? 'on_record_change'
  return t === 'on_record_change' || (t === 'on_create' && job.kind === 'created')
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

function runJob(job: Job) {
  const rs = useRecordStore.getState()
  const rec = rs.records.find((r) => r.id === job.recordId) ?? job.snapshot
  if (!rec) return
  const ws = rec.workspaceId
  if (job.moduleId !== rec.moduleId) return
  const reportError = (configId: string | undefined, message: string) => {
    if (configId) note(configId, { records: 1, error: message })
    collector?.errors.push({ recordId: rec.id, moduleId: rec.moduleId, configId, message })
  }
  if (ensureOutputFields(ws)) graphCache.delete(ws)
  const modules = useModuleStore.getState().modules
  const module = modules.find((m) => m.id === job.moduleId)
  if (!module) return
  const graph = graphFor(ws, modules)
  const changed = new Set(job.changed)
  for (const f of module.fields) if (f.type === 'formula') changed.add(keyOf(module.id, f.id))
  const written = new Set<string>()
  let current = rec

  if (isLive(rec) && !job.skipSelf) {
    const env = makeEnv(modules, rs.records)
    const doc = useEngineStore.getState().docOf(ws)
    const overlay: Record<string, unknown> = {}
    const writers = new Map<string, number>()
    const automations: { workflowId: string; nodeId: string }[] = []
    const ran = new Set<string>()
    const setField = (fieldId: string, value: unknown, nodeId: string) => {
      const cur = fieldId in overlay ? overlay[fieldId] : rec.data[fieldId]
      if (sameValue(cur, value)) return
      overlay[fieldId] = value
      changed.add(keyOf(module.id, fieldId))
      writers.set(nodeId, (writers.get(nodeId) ?? 0) + 1)
    }
    const runCalc = (calc: Calculation, nodeId: string) => {
      if (ran.has(calc.id)) return
      ran.add(calc.id)
      if (scopeOf(calc) !== 'record') return
      const { field } = outputFieldFor(calc, module)
      const res = runCalculation(calc, env, { record: rec, overlay })
      setField(field.id, toStored(res.value, calc, field), nodeId)
    }
    const nodeErrors = new Set<string>()
    for (const n of graph.order) {
      if (n.moduleId !== module.id) continue
      if (job.chain.includes(`engine:${n.id}`)) continue
      const forced = !!job.force && (!job.only || job.only.has(n.id))
      if (!forced && !(autoTrigger(n, job) && intersects(n.reads, changed))) continue
      try {
        if (n.kind === 'calculation') runCalc(n.config as Calculation, n.id)
        else {
          const out = evaluateRule(n.config as ConditionalRule, { module, record: rec, env, overlay })
          for (const e of out.effects) {
            if (e.kind === 'set') setField(e.fieldId, e.value, n.id)
            else if (e.kind === 'calculate') {
              const calc = doc.calculations.find((c) => c.enabled && (c.id === e.calculation || c.name === e.calculation))
              if (!calc) throw new EngineError(`Calculation "${e.calculation}" does not exist or is disabled`)
              runCalc(calc, n.id)
            } else automations.push({ workflowId: e.workflowId, nodeId: n.id })
          }
        }
        note(n.id, { records: 1 })
      } catch (e) {
        nodeErrors.add(n.id)
        reportError(n.id, msg(e))
      }
    }
    const patch: Record<string, unknown> = {}
    for (const [id, v] of Object.entries(overlay)) if (!sameValue(rec.data[id], v)) patch[id] = v
    if (Object.keys(patch).length) {
      const chain = [...job.chain, ...[...writers.keys()].map((id) => `engine:${id}`)]
      const res = rs.update(rec.id, patch, { depth: job.depth + 1, chain })
      if (!res || res.errors) {
        const why = res?.errors ? Object.values(res.errors)[0] : 'The record no longer exists'
        for (const id of writers.keys()) reportError(id, `The calculated value was refused: ${why}`)
      } else {
        current = res.record
        for (const k of Object.keys(patch)) {
          written.add(keyOf(module.id, k))
          changed.add(keyOf(module.id, k))
        }
        for (const [id, n] of writers) note(id, { writes: n })
        if (collector) collector.written += Object.keys(patch).length
      }
    }
    for (const a of automations) {
      const wf = useWorkflowStore.getState().items.find((w) => w.id === a.workflowId)
      if (!wf) reportError(a.nodeId, `Workflow "${a.workflowId}" does not exist`)
      else executeWorkflow(wf, current, job.depth + 1, { chain: [...job.chain, `engine:${a.nodeId}`] })
    }
  }

  // parents whose totals depend on this record
  const base = job.kind === 'created' || job.kind === 'deleted' || job.skipSelf ? allKeys(module) : changed
  const keys = new Set([...base, ...written])
  const links = linksOf(graph, modules)
  for (const n of graph.nodes) {
    const ls = links.get(n.id)?.filter((l) => l.childModuleId === module.id)
    if (!ls?.length || !intersects(n.reads, keys)) continue
    for (const l of ls) {
      const parents = new Set<string>()
      if (l.viaOn === 'child') {
        for (const id of toIds(current.data[l.viaFieldId])) parents.add(id)
        for (const id of toIds((job.prev ?? job.snapshot)?.data[l.viaFieldId])) parents.add(id)
      } else {
        for (const r of rs.records) if (r.moduleId === l.parentModuleId && isLive(r) && toIds(r.data[l.viaFieldId]).includes(rec.id)) parents.add(r.id)
      }
      for (const id of parents) enqueue({ recordId: id, moduleId: l.parentModuleId, changed: new Set(keys), kind: 'touch', level: job.level + 1, depth: job.depth, chain: job.chain })
    }
  }
}

// ---- queue -----------------------------------------------------------------------------------------------------

function enqueue(j: Job) {
  const ex = queue.get(j.recordId)
  if (!ex) {
    queue.set(j.recordId, j)
    return
  }
  j.changed.forEach((k) => ex.changed.add(k))
  ex.level = Math.max(ex.level, j.level)
  if (j.kind === 'created') ex.kind = 'created'
  ex.skipSelf = !!ex.skipSelf && !!j.skipSelf
  if (j.force) {
    if (!ex.force) {
      ex.force = true
      ex.only = j.only
    } else if (ex.only && j.only) j.only.forEach((id) => ex.only!.add(id))
    else ex.only = undefined
  }
  ex.prev = ex.prev ?? j.prev
  ex.snapshot = j.snapshot ?? ex.snapshot
}

function drain() {
  if (draining || batchDepth > 0) return
  draining = true
  let n = 0
  try {
    while (queue.size) {
      const [id, job] = queue.entries().next().value as [string, Job]
      queue.delete(id)
      if (++n > MAX_ENGINE_ITEMS) {
        const message = `Recalculation stopped after ${MAX_ENGINE_ITEMS} records: the configuration keeps triggering itself`
        note('__engine', { error: message })
        collector?.errors.push({ recordId: job.recordId, moduleId: job.moduleId, message })
        queue.clear()
        break
      }
      if (job.level > MAX_ENGINE_DEPTH) {
        const message = `Recalculation stopped: results cascaded through more than ${MAX_ENGINE_DEPTH} levels of related records`
        note('__engine', { error: message })
        collector?.errors.push({ recordId: job.recordId, moduleId: job.moduleId, message })
        continue
      }
      try {
        runJob(job)
      } catch (e) {
        note('__engine', { error: msg(e) })
        collector?.errors.push({ recordId: job.recordId, moduleId: job.moduleId, message: msg(e) })
      }
    }
  } finally {
    draining = false
    flushStatus()
  }
}

/**
 * Group many writes (an import, a bulk edit) into one recalculation pass: every record and every parent is recalculated
 * once, after `fn` finished, instead of once per write.
 */
export function runEngineBatch<T>(fn: () => T): T {
  batchDepth++
  try {
    return fn()
  } finally {
    batchDepth--
    if (batchDepth === 0) drain()
  }
}

// ---- events ----------------------------------------------------------------------------------------------------

const hasConfigs = (ws: string): boolean => {
  const d = useEngineStore.getState().docOf(ws)
  return d.calculations.some((c) => c.enabled) || d.conditional_rules.some((r) => r.enabled)
}

/** True when the write came from the engine itself (the cascade already ran in-process). */
export const isEngineWrite = (chain?: string[]): boolean => !!chain?.length && chain[chain.length - 1].startsWith('engine:')

export function handleRecordEvent(e: RecordEvent) {
  if (isEngineWrite(e.chain)) return
  const rec = e.record
  if (!hasConfigs(rec.workspaceId)) return
  const module = useModuleStore.getState().modules.find((m) => m.id === rec.moduleId)
  if (!module) return
  let changed: Set<string>
  if (e.type === 'updated' && e.previous) {
    changed = new Set()
    const keys = new Set([...Object.keys(e.previous.data), ...Object.keys(rec.data)])
    for (const k of keys) if (JSON.stringify(e.previous.data[k]) !== JSON.stringify(rec.data[k])) changed.add(keyOf(module.id, k))
    if (!changed.size) return
  } else changed = allKeys(module)
  enqueue({ recordId: rec.id, moduleId: rec.moduleId, changed, kind: e.type === 'created' ? 'created' : e.type === 'deleted' ? 'deleted' : 'updated', level: 0, depth: e.depth, chain: e.chain ?? [], prev: e.previous, snapshot: rec, skipSelf: e.type === 'deleted' })
  drain()
}

export function handleLifecycle(e: RecordLifecycle) {
  const leaving = e.kind === 'archive' || e.kind === 'purge'
  for (const rec of e.records) {
    if (!hasConfigs(rec.workspaceId)) continue
    const module = useModuleStore.getState().modules.find((m) => m.id === rec.moduleId)
    if (!module) continue
    enqueue({ recordId: rec.id, moduleId: rec.moduleId, changed: allKeys(module), kind: leaving ? 'deleted' : 'touch', level: 0, depth: 0, chain: [], snapshot: rec, skipSelf: leaving })
  }
  drain()
}

// ---- recalculate now -------------------------------------------------------------------------------------------

export interface RecalcProgress {
  phase: 'config' | 'module' | 'project'
  module: string
  done: number
  total: number
  written: number
  errors: number
}

export interface RecalcOptions {
  /** records per chunk; the UI thread gets a turn between chunks (default 200) */
  chunkSize?: number
  onProgress?: (p: RecalcProgress) => void
  signal?: { aborted: boolean }
  /** replace the between-chunk pause (tests) */
  yieldFn?: () => Promise<void>
}

export interface RecalcReport {
  processed: number
  written: number
  errors: RecalcError[]
  cancelled: boolean
  durationMs: number
  modules: string[]
}

const pause = () => new Promise<void>((r) => setTimeout(r, 0))

async function recalcModules(ws: string, moduleIds: string[], phase: RecalcProgress['phase'], opts: RecalcOptions, only?: Set<string>): Promise<RecalcReport> {
  const t0 = Date.now()
  const col: Collector = { errors: [], processed: 0, written: 0 }
  const chunk = Math.max(1, opts.chunkSize ?? 200)
  const outer = collector
  collector = col
  let cancelled = false
  try {
    ensureOutputFields(ws)
    const lists = moduleIds.map((id) => ({ id, name: useModuleStore.getState().modules.find((m) => m.id === id)?.name ?? id, ids: useRecordStore.getState().records.filter((r) => r.moduleId === id && isLive(r)).map((r) => r.id) }))
    const total = lists.reduce((a, l) => a + l.ids.length, 0)
    for (const l of lists) {
      for (let i = 0; i < l.ids.length; i += chunk) {
        if (opts.signal?.aborted) {
          cancelled = true
          break
        }
        for (const id of l.ids.slice(i, i + chunk)) enqueue({ recordId: id, moduleId: l.id, changed: new Set(), kind: 'touch', level: 0, depth: 0, chain: [], force: true, only })
        drain()
        col.processed += Math.min(chunk, l.ids.length - i)
        opts.onProgress?.({ phase, module: l.name, done: col.processed, total, written: col.written, errors: col.errors.length })
        await (opts.yieldFn ?? pause)()
      }
      if (cancelled) break
    }
  } finally {
    collector = outer
  }
  return { processed: col.processed, written: col.written, errors: col.errors, cancelled, durationMs: Date.now() - t0, modules: moduleIds }
}

/** Recalculate every calculation and rule of one module for all its records, chunked, with progress and per-record errors. */
export function recalculateModule(moduleId: string, opts: RecalcOptions = {}): Promise<RecalcReport> {
  const m = useModuleStore.getState().modules.find((x) => x.id === moduleId)
  if (!m) return Promise.resolve({ processed: 0, written: 0, errors: [{ recordId: '', moduleId, message: 'Module not found' }], cancelled: false, durationMs: 0, modules: [] })
  return recalcModules(m.workspaceId, [moduleId], 'module', opts)
}

/** Recalculate a whole project: modules in dependency order, so totals are computed from already-updated children. */
export function recalculateProject(ws: string, opts: RecalcOptions = {}): Promise<RecalcReport> {
  const graph = graphFor(ws)
  const seen: string[] = []
  for (const n of graph.order) if (n.moduleId && !seen.includes(n.moduleId)) seen.push(n.moduleId)
  return recalcModules(ws, seen, 'project', opts)
}

/** Recalculate one calculation or rule (and what depends on its output) for all records of its module. */
export function recalculateConfig(ws: string, configId: string, opts: RecalcOptions = {}): Promise<RecalcReport> {
  const node = graphFor(ws).order.find((n) => n.id === configId)
  if (!node || !node.moduleId) return Promise.resolve({ processed: 0, written: 0, errors: node ? [] : [{ recordId: '', moduleId: '', configId, message: 'Config not found, disabled, or part of a circular dependency' }], cancelled: false, durationMs: 0, modules: [] })
  return recalcModules(ws, [node.moduleId], 'config', opts, new Set([configId]))
}

// ---- schedule (while the app is open) --------------------------------------------------------------------------

const sessionRan = new Set<string>()
let timer: ReturnType<typeof setInterval> | undefined

export function dueScheduled(now: Date): { ws: string; id: string }[] {
  const out: { ws: string; id: string }[] = []
  for (const doc of useEngineStore.getState().docs) {
    const cfgs: (Calculation | ConditionalRule)[] = [...doc.calculations, ...doc.conditional_rules]
    for (const c of cfgs) {
      if (!c.enabled) continue
      const scheduled = (c.trigger ?? 'on_record_change') === 'schedule'
      // a result that depends on "today" goes stale on its own: refresh it daily even without an explicit schedule
      const clock = !scheduled && usesClock(c) && (('auto_update' in c ? c.auto_update !== false : true))
      if (!scheduled && !clock) continue
      const mode = scheduled ? (c.schedule ?? 'daily') : 'daily'
      const last = doc.lastScheduledRun[c.id] ? new Date(doc.lastScheduledRun[c.id]) : null
      const due = mode === 'on_open' ? !sessionRan.has(c.id) : mode === 'hourly' ? !last || now.getTime() - last.getTime() >= 3_600_000 : !last || !isSameDay(last, now)
      if (due) out.push({ ws: doc.id, id: c.id })
    }
  }
  return out
}

/** Run every configuration that is due. The run time is saved BEFORE running, so a reload or a second tab never repeats it. */
export function runDueSchedules(now = new Date(), opts: RecalcOptions = {}): Promise<RecalcReport[]> {
  const due = dueScheduled(now)
  for (const d of due) {
    sessionRan.add(d.id)
    useEngineStore.getState().markScheduledRun(d.ws, d.id, now.toISOString())
  }
  return Promise.all(due.map((d) => recalculateConfig(d.ws, d.id, opts)))
}

export const resetSchedulerSession = () => sessionRan.clear()

// ---- lifecycle -------------------------------------------------------------------------------------------------

let stops: (() => void)[] = []

/** Start listening to record writes (and the scheduler when running in a browser). Safe to call more than once. */
export function startEngine(): void {
  if (stops.length) return
  stops = [onRecordEvent(handleRecordEvent), onRecordLifecycle(handleLifecycle)]
  if (typeof window !== 'undefined') {
    setTimeout(() => void runDueSchedules(), 2500)
    timer = setInterval(() => void runDueSchedules(), 60_000)
  }
}

export function stopEngine(): void {
  stops.forEach((s) => s())
  stops = []
  if (timer) clearInterval(timer)
  timer = undefined
  queue.clear()
  graphCache.clear()
  resetSchedulerSession()
}

export const engineIsRunning = (): boolean => stops.length > 0
