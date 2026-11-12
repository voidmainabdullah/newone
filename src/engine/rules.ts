import { startOfDay } from 'date-fns'
import type { CrmRecord, Field, Module } from '#/types'
import { displayValue } from '#/utils/records'
import { EngineError, isBlank, isDateField, isNumberField, readField, resolveField, slug, toDate, toDec, type EngineEnv } from './resolve'
import { isGroup, type Action, type Condition, type ConditionNode, type ConditionalRuleBody, type Operator, type OperandValue } from './schema'

/**
 * Conditional rules, evaluated without side effects.
 *
 * `evaluateRule` answers "which actions apply to this record?" as a list of Effects; the runtime (runtime.ts) is
 * what writes fields, runs calculations and starts workflows. Conditions are compared on the record as it will be
 * after the current edit (`overlay`), so rules chained after a calculation see the calculated values.
 *
 * Null handling: a blank value never satisfies greater/less/between/before/after/contains/equal-to-something;
 * `not_equal`, `not_contains` and `not_in` are true for a blank value; `is_empty` is true for null, "" and [] (0 and false are values).
 */

export interface RecordCtx {
  module: Module
  record: CrmRecord
  env: EngineEnv
  /** field id -> value written but not stored yet */
  overlay?: Record<string, unknown>
}

export const fieldOrThrow = (module: Module, ref: string): Field => {
  const f = resolveField(module, ref)
  if (!f) throw new EngineError(`Unknown field "${ref}" in "${module.name}"`)
  return f
}

export function getValue(rc: RecordCtx, ref: string): { field: Field; value: unknown } {
  const field = fieldOrThrow(rc.module, ref)
  return { field, value: readField(rc.module, rc.record, field, rc.env, rc.overlay) }
}

/** which operators make sense for a field (the validator and the editors use this) */
export function operatorsFor(field: Field): Operator[] {
  const common: Operator[] = ['is_empty', 'is_not_empty']
  if (isNumberField(field)) return ['equal', 'not_equal', 'greater_than', 'less_than', 'greater_than_or_equal', 'less_than_or_equal', 'between', 'in', 'not_in', ...common]
  if (isDateField(field)) return ['equal', 'not_equal', 'before', 'after', 'greater_than', 'less_than', 'greater_than_or_equal', 'less_than_or_equal', 'between', ...common]
  if (field.type === 'yesNo') return ['equal', 'not_equal', 'is_true', 'is_false', ...common]
  if (['dropdown', 'radio'].includes(field.type)) return ['equal', 'not_equal', 'contains', 'not_contains', 'in', 'not_in', ...common]
  if (['multiSelect', 'checkboxes', 'tags', 'relationship', 'user'].includes(field.type)) return ['equal', 'not_equal', 'contains', 'not_contains', 'in', 'not_in', ...common]
  return ['equal', 'not_equal', 'contains', 'not_contains', 'in', 'not_in', ...common]
}

type Kind = 'date' | 'number' | 'bool' | 'text'
const kindOf = (f: Field): Kind => (isDateField(f) ? 'date' : isNumberField(f) ? 'number' : f.type === 'yesNo' ? 'bool' : 'text')

/** a literal, a { field } reference to another field of the same record, or a list of those */
export function operandValue(v: OperandValue | undefined, rc: RecordCtx): unknown {
  if (Array.isArray(v)) return v.map((x) => operandValue(x, rc))
  if (v && typeof v === 'object' && 'field' in v) return getValue(rc, v.field).value
  return v
}

const truthy = (v: unknown): boolean => v === true || (typeof v === 'string' && ['true', 'yes', '1', 'y'].includes(v.trim().toLowerCase())) || v === 1
const norm = (v: unknown): string => String(v ?? '').trim().toLowerCase()

function dateOf(v: unknown, now: Date): Date | null {
  if (typeof v === 'string') {
    const k = v.trim().toLowerCase()
    if (k === 'today') return startOfDay(now)
    if (k === 'now') return now
  }
  return toDate(v)
}

/** compare two values of the field's kind: -1/0/1, or null when either side is blank / unparsable */
function compare(left: unknown, right: unknown, field: Field, now: Date, forceDate = false): -1 | 0 | 1 | null {
  const kind = forceDate ? 'date' : kindOf(field)
  if (kind === 'date') {
    let a = dateOf(left, now)
    let b = dateOf(right, now)
    if (!a || !b) return null
    if (field.type !== 'datetime' && field.id !== '__createdAt' && field.id !== '__updatedAt') {
      a = startOfDay(a)
      b = startOfDay(b)
    } else if (typeof right === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(right)) {
      // comparing a timestamp with a plain date means "that day"
      a = startOfDay(a)
    }
    return a < b ? -1 : a > b ? 1 : 0
  }
  if (kind === 'number') {
    const a = toDec(left)
    const b = toDec(right)
    return a && b ? a.cmp(b) : null
  }
  if (isBlank(left) || isBlank(right)) return null
  const a = toDec(left)
  const b = toDec(right)
  if (a && b && typeof left !== 'string' && typeof right !== 'string') return a.cmp(b)
  const c = norm(left).localeCompare(norm(right), undefined, { numeric: true })
  return c < 0 ? -1 : c > 0 ? 1 : 0
}

function optionLabel(field: Field, v: unknown): string | undefined {
  return field.options?.find((o) => o.id === String(v))?.label
}

function equalValues(left: unknown, right: unknown, field: Field, now: Date): boolean {
  if (Array.isArray(left)) return left.some((x) => equalValues(x, right, field, now))
  if (Array.isArray(right)) return right.some((x) => equalValues(left, x, field, now))
  const lb = isBlank(left)
  const rb = isBlank(right)
  if (lb || rb) return lb && rb
  const kind = kindOf(field)
  if (kind === 'bool') return truthy(left) === truthy(right)
  if (kind === 'number' || kind === 'date') return compare(left, right, field, now) === 0
  const mine = [norm(left), norm(optionLabel(field, left))].filter(Boolean)
  const theirs = [norm(right), norm(optionLabel(field, right))].filter(Boolean)
  return mine.some((m) => theirs.includes(m))
}

function containsValue(left: unknown, right: unknown, field: Field, rc: RecordCtx): boolean {
  if (isBlank(right)) return false
  if (Array.isArray(left)) return left.some((x) => equalValues(x, right, field, rc.env.now))
  const needle = norm(right)
  return norm(displayValue(field, left, rc.env.ctx)).includes(needle) || norm(left).includes(needle)
}

export function evalCondition(c: Condition, rc: RecordCtx): boolean {
  const { field, value: left } = getValue(rc, c.field)
  const right = operandValue(c.value, rc)
  const now = rc.env.now
  switch (c.operator) {
    case 'equal': return equalValues(left, right, field, now)
    case 'not_equal': return !equalValues(left, right, field, now)
    case 'greater_than': { const c2 = compare(left, right, field, now); return c2 !== null && c2 > 0 }
    case 'greater_than_or_equal': { const c2 = compare(left, right, field, now); return c2 !== null && c2 >= 0 }
    case 'less_than': { const c2 = compare(left, right, field, now); return c2 !== null && c2 < 0 }
    case 'less_than_or_equal': { const c2 = compare(left, right, field, now); return c2 !== null && c2 <= 0 }
    case 'contains': return containsValue(left, right, field, rc)
    case 'not_contains': return !containsValue(left, right, field, rc)
    case 'is_empty': return isBlank(left)
    case 'is_not_empty': return !isBlank(left)
    case 'is_true': return truthy(left)
    case 'is_false': return !truthy(left)
    case 'between': {
      if (!Array.isArray(right) || right.length !== 2) throw new EngineError(`"between" on "${c.field}" needs a [from, to] pair`)
      const lo = compare(left, right[0], field, now)
      const hi = compare(left, right[1], field, now)
      return lo !== null && hi !== null && lo >= 0 && hi <= 0
    }
    case 'before': { const c2 = compare(left, right, field, now, true); return c2 !== null && c2 < 0 }
    case 'after': { const c2 = compare(left, right, field, now, true); return c2 !== null && c2 > 0 }
    case 'in':
    case 'not_in': {
      if (!Array.isArray(right)) throw new EngineError(`"${c.operator}" on "${c.field}" needs a list of values`)
      const hit = right.some((x) => equalValues(left, x, field, now))
      return c.operator === 'in' ? hit : !hit
    }
  }
}

export function evalNode(n: ConditionNode, rc: RecordCtx): boolean {
  if (isGroup(n)) return evalConditions(n.conditions, n.logic, rc)
  return evalCondition(n, rc)
}

/** AND (default) / OR over conditions and nested groups. An empty list is true. */
export function evalConditions(nodes: ConditionNode[] | undefined, logic: 'AND' | 'OR' | undefined, rc: RecordCtx): boolean {
  if (!nodes?.length) return true
  return logic === 'OR' ? nodes.some((n) => evalNode(n, rc)) : nodes.every((n) => evalNode(n, rc))
}

// ---- actions -> effects ----------------------------------------------------------------------------------------

export type Effect =
  | { kind: 'set'; fieldId: string; value: unknown; rule: number }
  | { kind: 'calculate'; calculation: string; rule: number }
  | { kind: 'automation'; workflowId: string; rule: number }

export interface RuleOutcome {
  /** indexes of the rules whose conditions held (in first_match mode at most one) */
  matched: number[]
  effects: Effect[]
}

/** The field a bare `set_status` writes to: "status", "stage", else the pipeline stage, else the first choice field. */
export function statusFieldOf(module: Module): Field | undefined {
  const named = module.fields.find((f) => ['status', 'stage'].includes(slug(f.name)) && (f.options?.length || f.type === 'shortText'))
  return named ?? module.fields.find((f) => f.pipeline) ?? module.fields.find((f) => (f.type === 'dropdown' || f.type === 'radio') && f.options?.length)
}

/** Convert a value written by a rule to what the field stores (option id, number, boolean, ISO date). */
export function coerceForField(field: Field, value: unknown): unknown {
  if (value === null || value === undefined || value === '') return null
  if (field.options?.length && (field.type === 'dropdown' || field.type === 'radio')) {
    const s = norm(value)
    const opt = field.options.find((o) => o.id === String(value)) ?? field.options.find((o) => norm(o.label) === s) ?? field.options.find((o) => slug(o.label) === slug(String(value)))
    if (!opt) throw new EngineError(`"${String(value)}" is not an option of "${field.label}" (${field.options.map((o) => o.label).join(', ')})`)
    return opt.id
  }
  if (isNumberField(field)) {
    const d = toDec(value)
    if (!d) throw new EngineError(`"${String(value)}" is not a number for "${field.label}"`)
    return d.toNumber()
  }
  if (field.type === 'yesNo') return truthy(value)
  return value
}

export function actionsOf(rule: { action?: Action; actions?: Action[] }): Action[] {
  return [...(rule.action ? [rule.action] : []), ...(rule.actions ?? [])]
}

function effectsOf(rc: RecordCtx, actions: Action[], rule: number): Effect[] {
  const out: Effect[] = []
  for (const a of actions) {
    switch (a.type) {
      case 'update_field': {
        const f = fieldOrThrow(rc.module, a.field)
        out.push({ kind: 'set', fieldId: f.id, value: coerceForField(f, operandValue(a.value, rc)), rule })
        break
      }
      case 'set_status': {
        const f = a.field ? fieldOrThrow(rc.module, a.field) : statusFieldOf(rc.module)
        if (!f) throw new EngineError(`"${rc.module.name}" has no status field; name the field in the action`)
        out.push({ kind: 'set', fieldId: f.id, value: coerceForField(f, a.value), rule })
        break
      }
      case 'calculate':
        out.push({ kind: 'calculate', calculation: a.calculation, rule })
        break
      case 'run_automation':
        out.push({ kind: 'automation', workflowId: a.workflow_id, rule })
        break
    }
  }
  return out
}

/**
 * Evaluate a rule set against one record.
 * first_match (default): the first rule whose conditions hold decides; the rest are not looked at.
 * all: every matching rule contributes, in order; when two write the same field the later one wins.
 */
export function evaluateRule(rule: Pick<ConditionalRuleBody, 'rules' | 'mode'>, rc: RecordCtx): RuleOutcome {
  const matched: number[] = []
  let effects: Effect[] = []
  for (let i = 0; i < rule.rules.length; i++) {
    const r = rule.rules[i]
    if (!evalConditions(r.conditions, r.logic, rc)) continue
    matched.push(i)
    effects = effects.concat(effectsOf(rc, actionsOf(r), i))
    if ((rule.mode ?? 'first_match') === 'first_match') break
  }
  // later writes to the same field replace earlier ones
  const lastSet = new Map<string, number>()
  effects.forEach((e, i) => e.kind === 'set' && lastSet.set(e.fieldId, i))
  effects = effects.filter((e, i) => e.kind !== 'set' || lastSet.get(e.fieldId) === i)
  return { matched, effects }
}

/** Field ids a rule set reads (conditions, field operands) and writes (update_field / set_status targets). */
export function rulePaths(rule: Pick<ConditionalRuleBody, 'rules'>, module: Module): { reads: Set<string>; writes: Set<string>; unknown: string[] } {
  const reads = new Set<string>()
  const writes = new Set<string>()
  const unknown: string[] = []
  const readRef = (ref: string) => {
    const f = resolveField(module, ref)
    if (f) reads.add(f.id)
    else {
      reads.add(`~${slug(ref)}`) // a field another config may still create
      unknown.push(ref)
    }
  }
  const operand = (v: OperandValue | undefined) => {
    if (Array.isArray(v)) v.forEach(operand)
    else if (v && typeof v === 'object' && 'field' in v) readRef(v.field)
  }
  const walk = (n: ConditionNode) => {
    if (isGroup(n)) n.conditions.forEach(walk)
    else {
      readRef(n.field)
      operand(n.value)
    }
  }
  for (const r of rule.rules) {
    r.conditions.forEach(walk)
    for (const a of actionsOf(r)) {
      if (a.type === 'update_field') {
        const f = resolveField(module, a.field)
        if (f) writes.add(f.id)
        else {
          writes.add(`~${slug(a.field)}`)
          unknown.push(a.field)
        }
        operand(a.value)
      } else if (a.type === 'set_status') {
        const f = a.field ? resolveField(module, a.field) : statusFieldOf(module)
        if (f) writes.add(f.id)
        else unknown.push(a.field ?? '(status)')
      }
    }
  }
  return { reads, writes, unknown }
}

/** The "Automatic Payment Status" rule set: Paid / Partial / Pending from paid_amount against total_amount. */
export function paymentStatusRule(entity: string, opts: { paid?: string; total?: string; status?: string } = {}): ConditionalRuleBody {
  const paid = opts.paid ?? 'paid_amount'
  const total = opts.total ?? 'total_amount'
  const status = opts.status ?? 'payment_status'
  return {
    type: 'conditional_rule',
    name: 'Automatic Payment Status',
    entity,
    trigger: 'on_record_change',
    mode: 'first_match',
    enabled: true,
    rules: [
      { name: 'Paid', logic: 'AND', conditions: [{ field: paid, operator: 'greater_than_or_equal', value: { field: total } }, { field: total, operator: 'greater_than', value: 0 }], action: { type: 'set_status', field: status, value: 'Paid' } },
      { name: 'Partial', logic: 'AND', conditions: [{ field: paid, operator: 'greater_than', value: 0 }, { field: paid, operator: 'less_than', value: { field: total } }], action: { type: 'set_status', field: status, value: 'Partial' } },
      { name: 'Pending', logic: 'OR', conditions: [{ field: paid, operator: 'is_empty' }, { field: paid, operator: 'equal', value: 0 }], action: { type: 'set_status', field: status, value: 'Pending' } },
    ],
  }
}
