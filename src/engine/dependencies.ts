import type { Field, Module } from '#/types'
import { resolveField, resolveModule, slug } from './resolve'
import { actionsOf, rulePaths } from './rules'
import { isGroup, type CalcCore, type Calculation, type ConditionNode, type ConditionalRule, type OperandValue } from './schema'
import { scopeOf } from './calc'

/**
 * Dependency graph of calculations and rules.
 *
 * Every config reads some fields and writes some fields, named `moduleId.fieldId` ("qualified keys"; a field that does not
 * exist yet, such as the not-yet-created output of another calculation, is `moduleId.~name`). A config B depends on A when
 * A writes something B reads. The graph gives the evaluation order (topological), tells which configs a changed field
 * touches, and rejects circular chains at save time with a message that names the cycle.
 */

export type ConfigNode = { kind: 'calculation'; config: Calculation } | { kind: 'rule'; config: ConditionalRule }

export interface DepNode {
  id: string
  kind: 'calculation' | 'rule'
  name: string
  /** module the config runs on ('' when the entity does not exist) */
  moduleId: string
  reads: Set<string>
  writes: Set<string>
  /** names that could not be resolved against the schema */
  unknown: string[]
  config: Calculation | ConditionalRule
}

export interface Graph {
  nodes: DepNode[]
  /** evaluation order: producers before consumers (nodes in a cycle are left out) */
  order: DepNode[]
  /** consumers of each node, by id */
  edges: Map<string, string[]>
  /** the first circular chain found, as node names: ["A", "B", "A"] */
  cycle: string[] | null
}

export const MAX_ENGINE_DEPTH = 8
export const MAX_ENGINE_ITEMS = 5000

export const fieldKey = (module: Module, ref: string): string => {
  const f = resolveField(module, ref)
  return `${module.id}.${f ? f.id : `~${slug(ref)}`}`
}
export const keyOf = (moduleId: string, fieldId: string): string => `${moduleId}.${fieldId}`

function walkNodes(nodes: ConditionNode[] | undefined, visit: (field: string, value?: OperandValue) => void) {
  for (const n of nodes ?? []) {
    if (isGroup(n)) walkNodes(n.conditions, visit)
    else visit(n.field, n.value)
  }
}
function operandRefs(v: OperandValue | undefined, out: string[]) {
  if (Array.isArray(v)) v.forEach((x) => operandRefs(x, out))
  else if (v && typeof v === 'object' && 'field' in v) out.push(v.field)
}

/** Reads and writes of one calculation. */
export function calcPaths(calc: Calculation, modules: Module[]): { reads: Set<string>; writes: Set<string>; unknown: string[]; moduleId: string } {
  const reads = new Set<string>()
  const writes = new Set<string>()
  const unknown: string[] = []
  const module = resolveModule(modules, calc.entity)
  if (!module) return { reads, writes, unknown: [calc.entity], moduleId: '' }
  const read = (m: Module, ref: string) => {
    // an unresolved name is reported as unknown; the validator forgives the ones another config is about to create
    if (!resolveField(m, ref)) unknown.push(ref)
    reads.add(fieldKey(m, ref))
  }
  const readNodes = (m: Module, nodes: ConditionNode[] | undefined) =>
    walkNodes(nodes, (f, v) => {
      read(m, f)
      const refs: string[] = []
      operandRefs(v, refs)
      refs.forEach((r) => read(m, r))
    })
  const walk = (core: CalcCore) => {
    let src = module
    if (core.related) {
      const rel = resolveModule(modules, core.related.entity)
      if (!rel) unknown.push(core.related.entity)
      else {
        src = rel
        // the link itself: on the related record (reverse) or on this record (forward)
        const there = resolveField(rel, core.related.via)
        if (there) reads.add(keyOf(rel.id, there.id))
        else {
          const here = resolveField(module, core.related.via)
          if (here) reads.add(keyOf(module.id, here.id))
          else unknown.push(core.related.via)
        }
      }
    }
    for (const i of core.inputs ?? []) {
      if ('field' in i) read(src, i.field)
      else if ('calc' in i) walk(i.calc)
    }
    for (const b of [core.then, core.else]) {
      if (b && 'field' in b) read(module, b.field)
      else if (b && 'calc' in b) walk(b.calc)
    }
    if (core.amount && typeof core.amount === 'object') read(module, core.amount.field)
    readNodes(src, core.filters)
    if (core.condition) readNodes(module, [core.condition])
  }
  walk(calc)
  if (calc.groupBy) read(module, calc.groupBy)
  if (typeof calc.dateRange === 'object' && calc.dateRange.field) read(module, calc.dateRange.field)
  if (scopeOf(calc) === 'record' && calc.output_field) writes.add(fieldKey(module, calc.output_field))
  return { reads, writes, unknown, moduleId: module.id }
}

export function nodeFor(c: ConfigNode, modules: Module[], calcs: Calculation[] = []): DepNode {
  if (c.kind === 'calculation') {
    const p = calcPaths(c.config, modules)
    return { id: c.config.id, kind: 'calculation', name: c.config.name, moduleId: p.moduleId, reads: p.reads, writes: p.writes, unknown: p.unknown, config: c.config }
  }
  const rule = c.config
  const module = resolveModule(modules, rule.entity)
  if (!module) return { id: rule.id, kind: 'rule', name: rule.name, moduleId: '', reads: new Set(), writes: new Set(), unknown: [rule.entity], config: rule }
  const p = rulePaths(rule, module)
  const reads = new Set([...p.reads].map((id) => keyOf(module.id, id)))
  const writes = new Set([...p.writes].map((id) => keyOf(module.id, id)))
  // a rule that runs a saved calculation also produces what that calculation writes
  for (const r of rule.rules) {
    for (const a of actionsOf(r)) {
      if (a.type !== 'calculate') continue
      const target = calcs.find((x) => x.id === a.calculation || x.name === a.calculation)
      if (target) calcPaths(target, modules).writes.forEach((w) => writes.add(w))
    }
  }
  return { id: rule.id, kind: 'rule', name: rule.name, moduleId: module.id, reads, writes, unknown: p.unknown, config: rule }
}

/**
 * Build the graph. A calculation that reads its own output is a cycle (a one-step cycle); a rule that reads what it
 * writes (a status machine: "if Pending then set Open") is allowed and left to the runtime loop cap.
 */
export function buildGraph(items: ConfigNode[], modules: Module[]): Graph {
  const calcs = items.filter((i): i is Extract<ConfigNode, { kind: 'calculation' }> => i.kind === 'calculation').map((i) => i.config)
  const nodes = items.map((i) => nodeFor(i, modules, calcs))
  const byWriter = new Map<string, DepNode[]>()
  for (const n of nodes) for (const w of n.writes) (byWriter.get(w) ?? byWriter.set(w, []).get(w)!).push(n)
  const edges = new Map<string, string[]>(nodes.map((n) => [n.id, []]))
  const indeg = new Map<string, number>(nodes.map((n) => [n.id, 0]))
  const seen = new Set<string>()
  for (const n of nodes) {
    for (const r of n.reads) {
      for (const w of byWriter.get(r) ?? []) {
        if (w.id === n.id && n.kind === 'rule') continue
        const k = `${w.id}>${n.id}`
        if (seen.has(k)) continue
        seen.add(k)
        edges.get(w.id)!.push(n.id)
        indeg.set(n.id, (indeg.get(n.id) ?? 0) + 1)
      }
    }
  }
  // Kahn, stable: nodes keep their saved order among equals
  const order: DepNode[] = []
  const left = new Map(indeg)
  const ready = nodes.filter((n) => left.get(n.id) === 0)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  while (ready.length) {
    const n = ready.shift()!
    order.push(n)
    for (const to of edges.get(n.id) ?? []) {
      left.set(to, (left.get(to) ?? 1) - 1)
      if (left.get(to) === 0) ready.push(byId.get(to)!)
    }
  }
  return { nodes, order, edges, cycle: order.length === nodes.length ? null : findCycle(nodes, edges) }
}

function findCycle(nodes: DepNode[], edges: Map<string, string[]>): string[] | null {
  const name = new Map(nodes.map((n) => [n.id, n.name]))
  const color = new Map<string, 0 | 1 | 2>()
  const stack: string[] = []
  let found: string[] | null = null
  const visit = (id: string) => {
    if (found) return
    color.set(id, 1)
    stack.push(id)
    for (const to of edges.get(id) ?? []) {
      if (found) return
      if (color.get(to) === 1) {
        const from = stack.indexOf(to)
        found = [...stack.slice(from), to].map((x) => name.get(x) ?? x)
        return
      }
      if (!color.get(to)) visit(to)
    }
    stack.pop()
    color.set(id, 2)
  }
  for (const n of nodes) if (!color.get(n.id)) visit(n.id)
  return found
}

/** A parent/child link a calculation aggregates over: the parent record's result depends on its child records. */
export interface RelLink {
  parentModuleId: string
  childModuleId: string
  viaFieldId: string
  /** 'child': the relationship field is on the child record (many payments -> one student). 'parent': it is on the parent (a student lists its payments). */
  viaOn: 'child' | 'parent'
}

export function relLinks(calc: Calculation, modules: Module[]): RelLink[] {
  const module = resolveModule(modules, calc.entity)
  if (!module) return []
  const out: RelLink[] = []
  const walk = (core: CalcCore) => {
    if (core.related) {
      const rel = resolveModule(modules, core.related.entity)
      if (rel) {
        const there = resolveField(rel, core.related.via)
        const here = resolveField(module, core.related.via)
        if (there?.type === 'relationship' && there.relation?.moduleId === module.id) out.push({ parentModuleId: module.id, childModuleId: rel.id, viaFieldId: there.id, viaOn: 'child' })
        else if (here?.type === 'relationship' && here.relation?.moduleId === rel.id) out.push({ parentModuleId: module.id, childModuleId: rel.id, viaFieldId: here.id, viaOn: 'parent' })
      }
    }
    for (const i of core.inputs ?? []) if ('calc' in i) walk(i.calc)
    for (const b of [core.then, core.else]) if (b && 'calc' in b) walk(b.calc)
  }
  walk(calc)
  return out
}

/** Does the result depend on the clock ("today" / "now" as an input or a condition value, or a date preset window)? Such configs need a scheduled refresh. */
export function usesClock(c: Calculation | ConditionalRule): boolean {
  let hit = false
  const clockValue = (v: unknown) => typeof v === 'string' && ['today', 'now'].includes(v.trim().toLowerCase())
  const nodes = (list: ConditionNode[] | undefined) => {
    for (const n of list ?? []) {
      if (isGroup(n)) nodes(n.conditions)
      else if (clockValue(n.value) || (Array.isArray(n.value) && n.value.some(clockValue))) hit = true
    }
  }
  const walk = (core: CalcCore) => {
    for (const i of core.inputs ?? []) {
      if ('value' in i && clockValue(i.value)) hit = true
      else if ('calc' in i) walk(i.calc)
    }
    for (const b of [core.then, core.else]) {
      if (b && 'value' in b && clockValue(b.value)) hit = true
      else if (b && 'calc' in b) walk(b.calc)
    }
    nodes(core.filters)
    if (core.condition) nodes([core.condition])
  }
  if ('rules' in c) for (const r of c.rules) nodes(r.conditions)
  else walk(c)
  return hit
}

export const describeCycle = (cycle: string[]): string => `Circular dependency: ${cycle.map((n) => `"${n}"`).join(' → ')}. A calculation cannot depend on its own result, directly or through other calculations and rules.`

/** The configs that run when these fields change, in evaluation order, including the ones reached through their outputs. */
export function affectedNodes(graph: Graph, changed: Set<string>): DepNode[] {
  const hit = new Set<string>()
  const keys = new Set(changed)
  // fixpoint over the topological order: one pass is enough, outputs only feed later nodes
  for (const n of graph.order) {
    for (const r of n.reads) {
      if (keys.has(r)) {
        hit.add(n.id)
        n.writes.forEach((w) => keys.add(w))
        break
      }
    }
  }
  return graph.order.filter((n) => hit.has(n.id))
}

export const fieldIds = (m: Module): string[] => m.fields.map((f: Field) => f.id)
