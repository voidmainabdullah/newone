import type { Field, Module } from '#/types'
import { configureShape } from './nlIntent'
import { isDateField, isNumberField, slug } from './resolve'
import type {
  Aggregation,
  CalculationBody,
  ConditionalRuleBody,
  ConditionNode,
  DashboardBody,
  DashboardWidgetShape,
  DateRangeSpec,
  OperandValue,
  Operator,
  Preset,
  RuleItem,
  WidgetKind,
  Action,
  Input,
} from './schema'

/**
 * Deterministic natural language -> engine configuration. No model, no API key, no network.
 *
 * It reads a request against the REAL schema (the workspace's modules and fields) and returns either
 *   - a draft: a calculation, a conditional rule or a dashboard in the engine schema (the caller still validates it with
 *     validate.ts before anything is saved or run), or
 *   - a clarification: a question with options, when a module or field is missing or two of them match equally.
 * It never invents a field, never picks between equal matches and never executes anything.
 *
 * Answers to an earlier clarification come back in `options.answers` (question id -> chosen label) and are used the next
 * time the same request is parsed, so a question is never asked twice.
 */

export interface NlOptions {
  answers?: Record<string, string>
}

export interface NlDraft {
  kind: 'draft'
  configKind: 'calculations' | 'conditional_rules' | 'dashboards'
  body: CalculationBody | ConditionalRuleBody | DashboardBody
  /** one sentence: what this will do */
  summary: string
  /** module the config belongs to (undefined for a dashboard that spans modules) */
  entity?: string
  /** choices made on the user's behalf, in plain words */
  assumptions: string[]
}

export interface NlClarify {
  kind: 'clarify'
  id: string
  question: string
  options: string[]
  why: string
}

export interface NlNone {
  kind: 'none'
  /** why this request is not something the deterministic parser handles (the AI path may still) */
  reason: string
}

export type NlResult = NlDraft | NlClarify | NlNone

// ---- text helpers ------------------------------------------------------------------------------------------------

const STOP = new Set(['the', 'a', 'an', 'of', 'for', 'to', 'in', 'on', 'my', 'our', 'all', 'each', 'every', 'record', 'field', 'column', 'this', 'that', 'their', 'its'])
const GENERIC = new Set(['amount', 'total', 'number', 'value', 'date', 'count'])
const GROUPS: string[][] = [
  ['paid', 'received', 'collected'],
  ['remaining', 'outstanding', 'unpaid', 'owed', 'balance', 'due', 'left'],
  ['cost', 'expense', 'spend', 'expenditure'],
  ['income', 'revenue', 'sale', 'earning'],
  ['attendance', 'present'],
]
const GROUP_OF = new Map<string, number>()
GROUPS.forEach((g, i) => g.forEach((w) => GROUP_OF.set(w, i)))
const sameGroup = (a: string, b: string): boolean => GROUP_OF.has(a) && GROUP_OF.get(a) === GROUP_OF.get(b)

const sing = (w: string): string => {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`
  if (w.length > 4 && /(ses|xes|ches|shes)$/.test(w)) return w.slice(0, -2)
  if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) return w.slice(0, -1)
  return w
}
const words = (s: string): string[] => s.toLowerCase().replace(/[_-]+/g, ' ').replace(/[^a-z0-9% ]+/g, ' ').split(/\s+/).filter(Boolean)
const keyWords = (s: string): string[] => words(s).filter((w) => !STOP.has(w)).map(sing)
const norm = (s: string): string => words(s).join(' ')
const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s)
const unquote = (s: string): string => s.trim().replace(/^["“'‘]+|["”'’]+$/g, '').trim()

function lev(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return dp[a.length][b.length]
}

/** How well does the phrase name the candidate? 0 = not at all, 100 = exactly. Deterministic. */
export function nameScore(phrase: string, candidate: string): number {
  const pw = keyWords(phrase)
  const cw = keyWords(candidate)
  if (!pw.length || !cw.length) return 0
  if (pw.join(' ') === cw.join(' ')) return 100
  if (pw.every((w) => cw.includes(w))) return 80 - Math.min(10, cw.length - pw.length)
  if (cw.every((w) => pw.includes(w))) return 70 - Math.min(10, pw.length - cw.length)
  const key = pw.filter((w) => !GENERIC.has(w))
  if (key.length && key.every((w) => cw.some((c) => c === w || sameGroup(w, c)))) return 62
  if (key.length === 1 && cw.some((c) => c.length >= 5 && key[0].length >= 5 && lev(c, key[0]) <= 1)) return 60
  return 0
}

const hashOf = (s: string): string => {
  let h = 5381
  for (const ch of norm(s)) h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0
  return h.toString(36)
}

// ---- errors and context ------------------------------------------------------------------------------------------

/** Question ids are at most 64 characters (the Studio question schema); the same clipping is applied when an answer is looked up. */
const clipId = (id: string): string => id.slice(0, 64)

class Clarify extends Error {
  readonly q: Omit<NlClarify, 'kind'>
  constructor(q: Omit<NlClarify, 'kind'>, readonly score: number) {
    super(q.question)
    this.q = { ...q, id: clipId(q.id) }
  }
}
class Unsupported extends Error {}

interface Ctx {
  modules: Module[]
  answers: Record<string, string>
  h: string
  assumptions: string[]
  score: number
}

const WHY = 'I only use modules and fields that exist in your CRM, and I do not guess between matches.'
const fieldsOf = (m: Module): Field[] => m.fields.filter((f) => !f.id.startsWith('__'))
const wantOk = (f: Field, want: Want): boolean => (want === 'number' ? isNumberField(f) : want === 'date' ? isDateField(f) : want === 'choice' ? f.type === 'dropdown' || f.type === 'radio' : true)
type Want = 'any' | 'number' | 'date' | 'choice'
const nameOf = (f: Field): string => f.name || f.id
const refOf = (f: Field): { field: string } => ({ field: nameOf(f) })
const moduleNames = (m: Module): string[] => [m.name, m.singularName ?? '', m.id].filter(Boolean)
const moduleScore = (phrase: string, m: Module): number => Math.max(...moduleNames(m).map((n) => nameScore(phrase, n)))
const labelEq = (a: string, b: string): boolean => norm(a) === norm(b)
const answerOf = (ctx: Ctx, id: string): string | undefined => ctx.answers[clipId(id)] ?? ctx.answers[id]

function fieldFor(ctx: Ctx, module: Module, phrase: string, want: Want = 'any'): Field {
  const id = `nl_${ctx.h}_f_${slug(phrase)}_${slug(module.id)}`
  const pool = fieldsOf(module).filter((f) => wantOk(f, want))
  const answer = answerOf(ctx, id)
  if (answer) {
    const hit = fieldsOf(module).find((f) => labelEq(f.label, answer) || labelEq(f.name, answer))
    if (hit) return hit
  }
  const ranked = pool.map((f) => ({ f, s: Math.max(nameScore(phrase, f.label), nameScore(phrase, f.name)) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s)
  const top = ranked[0]
  const listed = (pool.length ? pool : fieldsOf(module)).slice(0, 8).map((f) => f.label)
  if (!top || top.s < 60) {
    const typeNote = want === 'number' ? ' number' : want === 'date' ? ' date' : ''
    throw new Clarify({ id, question: `I couldn't find a${typeNote} field called “${phrase}” in ${module.name}. Which field did you mean?`, options: listed, why: WHY }, ctx.score)
  }
  const ties = ranked.filter((x) => x.s === top.s)
  if (ties.length > 1) throw new Clarify({ id, question: `“${phrase}” could mean more than one field in ${module.name}. Which one?`, options: ties.map((x) => x.f.label), why: WHY }, ctx.score)
  ctx.score += top.s
  return top.f
}

function moduleFor(ctx: Ctx, phrase: string): Module {
  const id = `nl_${ctx.h}_mod_${slug(phrase)}`
  const answer = answerOf(ctx, id)
  if (answer) {
    const hit = ctx.modules.find((m) => labelEq(m.name, answer))
    if (hit) return hit
  }
  const ranked = ctx.modules.map((m) => ({ m, s: moduleScore(phrase, m) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s)
  const top = ranked[0]
  if (!top || top.s < 60) throw new Clarify({ id, question: `I couldn't find a module called “${phrase}”. Which module did you mean?`, options: ctx.modules.map((m) => m.name), why: WHY }, ctx.score)
  const ties = ranked.filter((x) => x.s === top.s)
  if (ties.length > 1) throw new Clarify({ id, question: `“${phrase}” matches more than one module. Which one?`, options: ties.map((x) => x.m.name), why: WHY }, ctx.score)
  ctx.score += top.s
  return top.m
}

/** The option of a choice field the phrase names (by label or id), or a clarification listing the real options. */
function optionFor(ctx: Ctx, field: Field, phrase: string): string {
  const id = `nl_${ctx.h}_o_${slug(field.id)}_${slug(phrase)}`
  const options = field.options ?? []
  const answer = answerOf(ctx, id)
  if (answer) {
    const hit = options.find((o) => labelEq(o.label, answer))
    if (hit) return hit.label
  }
  const p = unquote(phrase)
  const hit = options.find((o) => labelEq(o.label, p) || labelEq(o.id, p)) ?? options.find((o) => keyWords(o.label).join(' ') === keyWords(p).join(' '))
  if (hit) {
    ctx.score += 10
    return hit.label
  }
  throw new Clarify({ id, question: `“${p}” is not one of the options of ${field.label}. Which option did you mean?`, options: options.map((o) => o.label), why: WHY }, ctx.score)
}

/** Run `fn` for the module it belongs to: the one where every name resolves, the best match when several do. */
function inModule<T>(ctx: Ctx, request: string, fn: (m: Module, c: Ctx) => T, forced?: Module): { module: Module; value: T } {
  const id = `nl_${ctx.h}_module`
  const picked = answerOf(ctx, id)
  const answered = picked ? ctx.modules.find((m) => labelEq(m.name, picked)) : undefined
  const only = forced ?? answered
  if (only) {
    const value = fn(only, ctx)
    return { module: only, value }
  }
  const mentioned = (m: Module) => moduleNames(m).some((n) => keyWords(n).length > 0 && keyWords(n).every((w) => keyWords(request).includes(w)))
  const oks: { module: Module; value: T; score: number; assumptions: string[] }[] = []
  let worst: Clarify | undefined
  let unsupported: Unsupported | undefined
  for (const m of ctx.modules) {
    const sub: Ctx = { ...ctx, assumptions: [], score: 0 }
    try {
      oks.push({ module: m, value: fn(m, sub), score: sub.score, assumptions: sub.assumptions })
    } catch (e) {
      if (e instanceof Clarify) {
        if (!worst || e.score > worst.score) worst = e
      } else if (e instanceof Unsupported) unsupported ??= e
      else throw e
    }
  }
  if (!oks.length) {
    if (worst) throw worst
    throw unsupported ?? new Unsupported('no module fits this request')
  }
  oks.sort((a, b) => b.score - a.score)
  const top = oks.filter((x) => x.score === oks[0].score)
  let pick = top[0]
  if (top.length > 1) {
    const named = top.filter((x) => mentioned(x.module))
    if (named.length === 1) pick = named[0]
    else throw new Clarify({ id, question: 'More than one module has all of those fields. Which module should this apply to?', options: top.map((x) => x.module.name), why: WHY }, ctx.score)
  }
  ctx.score += pick.score
  ctx.assumptions.push(...pick.assumptions)
  return { module: pick.module, value: pick.value }
}

// ---- literals and conditions ---------------------------------------------------------------------------------------

const parseNum = (s: string): number | undefined => {
  const t = s.trim().replace(/[,$£€%\s]/g, '')
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : undefined
}

const SYMBOLS: [string, Operator][] = [['>=', 'greater_than_or_equal'], ['≥', 'greater_than_or_equal'], ['<=', 'less_than_or_equal'], ['≤', 'less_than_or_equal'], ['!=', 'not_equal'], ['≠', 'not_equal'], ['>', 'greater_than'], ['<', 'less_than'], ['=', 'equal']]
const OP_WORDS: [string, Operator][] = [
  ['is not equal to', 'not_equal'], ['is not empty', 'is_not_empty'], ['is not blank', 'is_not_empty'], ['is filled in', 'is_not_empty'], ['has a value', 'is_not_empty'], ['is set', 'is_not_empty'],
  ['is greater than or equal to', 'greater_than_or_equal'], ['greater than or equal to', 'greater_than_or_equal'], ['is at least', 'greater_than_or_equal'], ['at least', 'greater_than_or_equal'], ['no less than', 'greater_than_or_equal'],
  ['is less than or equal to', 'less_than_or_equal'], ['less than or equal to', 'less_than_or_equal'], ['is at most', 'less_than_or_equal'], ['at most', 'less_than_or_equal'], ['no more than', 'less_than_or_equal'],
  ['is greater than', 'greater_than'], ['greater than', 'greater_than'], ['is more than', 'greater_than'], ['more than', 'greater_than'], ['is above', 'greater_than'], ['above', 'greater_than'], ['exceeds', 'greater_than'], ['is over', 'greater_than'], ['over', 'greater_than'], ['higher than', 'greater_than'], ['bigger than', 'greater_than'],
  ['is less than', 'less_than'], ['less than', 'less_than'], ['is below', 'less_than'], ['below', 'less_than'], ['is under', 'less_than'], ['under', 'less_than'], ['fewer than', 'less_than'], ['lower than', 'less_than'], ['smaller than', 'less_than'],
  ['does not contain', 'not_contains'], ['contains', 'contains'], ['includes', 'contains'],
  ['is empty', 'is_empty'], ['is blank', 'is_empty'], ['has no value', 'is_empty'], ['is missing', 'is_empty'], ['is not', 'not_equal'], ["isn't", 'not_equal'], ['not equal to', 'not_equal'],
  ['is before', 'before'], ['before', 'before'], ['is after', 'after'], ['after', 'after'],
  ['is equal to', 'equal'], ['equals', 'equal'], ['equal to', 'equal'], ['is', 'equal'], ['are', 'equal'], ['was', 'equal'],
]
const NO_VALUE = new Set<Operator>(['is_empty', 'is_not_empty', 'is_true', 'is_false'])

interface Hit {
  index: number
  length: number
  op: Operator
}
function findOperator(clause: string): Hit | undefined {
  let best: Hit | undefined
  const take = (h: Hit) => {
    if (!best || h.index < best.index || (h.index === best.index && h.length > best.length)) best = h
  }
  for (const [sym, op] of SYMBOLS) {
    const i = clause.indexOf(sym)
    if (i >= 0) take({ index: i, length: sym.length, op })
  }
  for (const [word, op] of OP_WORDS) {
    const m = new RegExp(`(^|\\s)(${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?=\\s|$)`, 'i').exec(clause)
    if (m) take({ index: m.index + m[1].length, length: word.length, op })
  }
  return best
}

function valueFor(ctx: Ctx, module: Module, field: Field, op: Operator, phrase: string): OperandValue | undefined {
  if (NO_VALUE.has(op)) return undefined
  const p = unquote(phrase.replace(/\s+(?:then|and then)$/i, ''))
  if (!p) throw new Unsupported(`"${field.label}" needs a value`)
  if (field.type === 'dropdown' || field.type === 'radio') return optionFor(ctx, field, p)
  if (field.type === 'yesNo') {
    if (/^(yes|true|checked|on|ticked)$/i.test(p)) return true
    if (/^(no|false|unchecked|off|unticked)$/i.test(p)) return false
    throw new Unsupported(`"${p}" is not yes or no`)
  }
  if (isNumberField(field)) {
    const n = parseNum(p)
    if (n !== undefined) return n
    return refOf(fieldFor(ctx, module, p, 'number'))
  }
  if (isDateField(field)) {
    if (/^(today|now)$/i.test(p)) return 'today'
    if (/^\d{4}-\d{2}-\d{2}$/.test(p)) return p
    return refOf(fieldFor(ctx, module, p, 'date'))
  }
  return p
}

interface Clause {
  field: Field
  op: Operator
  value?: OperandValue
}

function parseClause(ctx: Ctx, module: Module, text: string, carry?: Field): Clause {
  const hit = findOperator(text)
  if (!hit) throw new Unsupported(`I could not find a comparison in "${text}"`)
  const left = text.slice(0, hit.index).trim()
  const right = text.slice(hit.index + hit.length).trim()
  const field = left ? fieldFor(ctx, module, left, 'any') : carry
  if (!field) throw new Unsupported(`"${text}" does not say which field it is about`)
  let op = hit.op
  if (field.type === 'yesNo' && (op === 'equal' || op === 'not_equal')) {
    const v = valueFor(ctx, module, field, op, right)
    const truthy = op === 'equal' ? v === true : v === false
    return { field, op: truthy ? 'is_true' : 'is_false' }
  }
  if (field.type === 'multiSelect' && op === 'equal') op = 'contains'
  return { field, op, value: valueFor(ctx, module, field, op, right) }
}

const node = (c: Clause): ConditionNode => ({ field: nameOf(c.field), operator: c.op, ...(c.value !== undefined ? { value: c.value } : {}) })

interface Parsed {
  nodes: ConditionNode[]
  logic: 'AND' | 'OR'
}

/** "A and B", "A or B", "A and B or C" (and binds tighter). A clause that starts with a comparison reuses the previous field. */
function parseConditions(ctx: Ctx, module: Module, text: string): Parsed {
  const t = text.replace(/\bbetween\s+(\S+)\s+and\s+(\S+)/gi, 'between $1 ~ $2').trim()
  const groups = t.split(/\s+or\s+(?!equal\b)/i).map((g) => g.split(/\s*,\s*(?=\D)|\s+and\s+/i).map((x) => x.trim()).filter(Boolean))
  let carry: Field | undefined
  const out: ConditionNode[][] = []
  for (const g of groups) {
    const nodes: ConditionNode[] = []
    for (const clause of g) {
      if (/\bbetween\b/i.test(clause) && clause.includes('~')) {
        const [l, r] = clause.split(/\s+between\s+/i)
        const field = fieldFor(ctx, module, l, 'any')
        const [a, b] = r.split('~').map((x) => valueFor(ctx, module, field, 'between', x) as OperandValue)
        nodes.push({ field: nameOf(field), operator: 'between', value: [a, b] as never })
        carry = field
        continue
      }
      const c = parseClause(ctx, module, clause, carry)
      carry = c.field
      nodes.push(node(c))
    }
    out.push(nodes)
  }
  if (out.length === 1) return { nodes: out[0], logic: 'AND' }
  return { nodes: out.map((g) => (g.length === 1 ? g[0] : { logic: 'AND' as const, conditions: g })), logic: 'OR' }
}

const asFilters = (p: Parsed): ConditionNode[] => (p.logic === 'AND' ? p.nodes : [{ logic: 'OR', conditions: p.nodes }])

// ---- metrics (aggregate calculations and dashboard widgets) ---------------------------------------------------------

type Agg = 'count' | 'sum' | 'average' | 'min' | 'max'
interface Metric {
  title: string
  module: Module
  agg: Agg
  field?: Field
  filters: ConditionNode[]
  range?: DateRangeSpec
}

const AGG_WORDS: Record<string, Agg | 'total'> = { total: 'total', sum: 'sum', count: 'count', number: 'count', 'how many': 'count', average: 'average', avg: 'average', mean: 'average', minimum: 'min', min: 'min', lowest: 'min', smallest: 'min', maximum: 'max', max: 'max', highest: 'max', biggest: 'max', largest: 'max' }
const AGG_RE = /^(total|sum|count|number|how many|average|avg|mean|minimum|min|lowest|smallest|maximum|max|highest|biggest|largest)\b\s*(?:of\s+)?(.*)$/i

const PERIODS: [RegExp, Preset][] = [
  [/\b(?:this|current) month\b/i, 'this_month'], [/\bthis week\b/i, 'this_week'], [/\b(?:this year|year to date|ytd)\b/i, 'this_year'], [/\btoday\b/i, 'today'], [/\blast month\b/i, 'last_month'],
  [/\b(?:last|past) 7 days\b/i, 'last_7_days'], [/\b(?:last|past) week\b/i, 'last_7_days'], [/\b(?:last|past) 30 days\b/i, 'last_30_days'], [/\b(?:last|past) 90 days\b/i, 'last_90_days'],
]

function takePeriod(t: string): { text: string; preset?: Preset } {
  for (const [re, preset] of PERIODS) if (re.test(t)) return { text: t.replace(re, '').replace(/\s{2,}/g, ' ').replace(/\s+(?:(?:in|for|during|over|within)(?:\s+the)?|so far)\s*$/i, '').trim(), preset }
  return { text: t }
}

function rangeFor(ctx: Ctx, module: Module, preset: Preset | undefined, forced?: string): DateRangeSpec | undefined {
  if (!preset) return undefined
  const dates = fieldsOf(module).filter((f) => (f.type === 'date' || f.type === 'datetime') && !f.calculated)
  const df = forced ? fieldFor(ctx, module, forced, 'date') : dates.length === 1 ? dates[0] : undefined
  if (df) return { preset, field: nameOf(df) }
  ctx.assumptions.push(`${module.name} has ${dates.length ? 'several date fields' : 'no date field'}, so the period uses the date each record was created.`)
  return preset
}

interface Across {
  module: Module
  field: Field
  score: number
}
function across(ctx: Ctx, phrase: string, want: Want): Across {
  const mid = `nl_${ctx.h}_mod_${slug(phrase)}`
  const all: Across[] = []
  for (const m of ctx.modules) for (const f of fieldsOf(m)) if (wantOk(f, want)) all.push({ module: m, field: f, score: Math.max(nameScore(phrase, f.label), nameScore(phrase, f.name)) })
  const ranked = all.filter((x) => x.score > 0).sort((a, b) => b.score - a.score)
  const answer = answerOf(ctx, mid)
  if (answer) {
    const m = ctx.modules.find((x) => labelEq(x.name, answer))
    if (m) return { module: m, field: fieldFor(ctx, m, phrase, want), score: 0 }
  }
  const top = ranked[0]
  if (!top || top.score < 60) {
    const options = ranked.slice(0, 8).map((x) => `${x.module.name}: ${x.field.label}`)
    throw new Clarify({ id: `nl_${ctx.h}_any_${slug(phrase)}`, question: `I couldn't find a${want === 'number' ? ' number' : ''} field called “${phrase}” in any module. Which one did you mean?`, options: options.length ? options : all.slice(0, 8).map((x) => `${x.module.name}: ${x.field.label}`), why: WHY }, ctx.score)
  }
  const ties = ranked.filter((x) => x.score === top.score)
  if (ties.length > 1) {
    const sameModule = ties.every((x) => x.module.id === top.module.id)
    if (sameModule) throw new Clarify({ id: `nl_${ctx.h}_f_${slug(phrase)}_${slug(top.module.id)}`, question: `“${phrase}” could mean more than one field in ${top.module.name}. Which one?`, options: ties.map((x) => x.field.label), why: WHY }, ctx.score)
    throw new Clarify({ id: mid, question: `“${phrase}” exists in more than one module. Which module did you mean?`, options: [...new Set(ties.map((x) => x.module.name))], why: WHY }, ctx.score)
  }
  ctx.score += top.score
  return top
}

function moduleMatch(ctx: Ctx, phrase: string): Module | undefined {
  const ranked = ctx.modules.map((m) => ({ m, s: moduleScore(phrase, m) })).filter((x) => x.s >= 90).sort((a, b) => b.s - a.s)
  if (!ranked.length) return undefined
  const ties = ranked.filter((x) => x.s === ranked[0].s)
  return ties.length === 1 ? ties[0].m : undefined
}

/** "paid fees" = a word that qualifies a module: the module is the trailing words, the rest names one of its fields. */
function adjectiveModule(ctx: Ctx, phrase: string): { module: Module; adj: string } | undefined {
  const tw = keyWords(phrase)
  let best: { module: Module; adj: string; n: number } | undefined
  for (const m of ctx.modules)
    for (const name of moduleNames(m)) {
      const mw = keyWords(name)
      if (!mw.length || tw.length <= mw.length) continue
      if (mw.every((w, i) => tw[tw.length - mw.length + i] === w) && (!best || mw.length > best.n)) best = { module: m, adj: tw.slice(0, tw.length - mw.length).join(' '), n: mw.length }
    }
  return best
}

function parseMetric(ctx: Ctx, raw: string): Metric {
  const t0 = raw.trim().replace(/^(?:(?:please|show|display|add|create|calculate|compute|give me|the|a|an|my|our|number|widget|card)\s+)+/i, (m) => (/\bnumber\s*$/i.test(m) ? 'number ' : '')).trim()
  const { text: t1, preset } = takePeriod(t0)
  const cond = /^(.*?)\s+(?:where|whose|with|having|that have|which have|that has)\s+(.+)$/i.exec(t1)
  const main = (cond ? cond[1] : t1).trim()
  const condText = cond?.[2]
  const am = AGG_RE.exec(main)
  const aggWord = am ? AGG_WORDS[am[1].toLowerCase()] : undefined
  let rest = (am ? am[2] : main).trim()
  const numeric = aggWord === 'sum' || aggWord === 'average' || aggWord === 'min' || aggWord === 'max'
  let modPhrase: string | undefined
  const mm = /^(.*?)\s+(?:in|from|across|within|for|of)\s+(?:the\s+)?(.+)$/i.exec(rest)
  if (mm) {
    rest = mm[1].trim()
    modPhrase = mm[2].trim()
  }
  const title = cap(raw.trim().replace(/^(?:(?:please|show|display|add|create|calculate|compute|give me)\s+)+/i, '').replace(/^(?:the|a|an)\s+/i, ''))

  let module: Module | undefined
  let field: Field | undefined
  let agg: Agg = 'count'
  const filters: ConditionNode[] = []

  if (modPhrase) {
    module = moduleFor(ctx, modPhrase)
    const sameAsModule = !rest || moduleScore(rest, module) >= 90
    if (sameAsModule && !numeric) agg = 'count'
    else {
      field = fieldFor(ctx, module, rest, numeric || aggWord === 'total' ? 'number' : 'any')
      agg = numeric ? (aggWord as Agg) : 'sum'
    }
  } else {
    const asModule = rest ? moduleMatch(ctx, rest) : undefined
    if (asModule && !numeric) {
      module = asModule
      agg = 'count'
      if (aggWord === 'total') ctx.assumptions.push(`“${rest}” counts the records of ${asModule.name}. Name a field (for example “total ${asModule.name} amount”) to add up a number instead.`)
    } else if (numeric || aggWord === 'total') {
      try {
        const a = across(ctx, rest, 'number')
        module = a.module
        field = a.field
        agg = numeric ? (aggWord as Agg) : 'sum'
      } catch (e) {
        if (e instanceof Clarify && asModule) throw new Clarify({ id: `nl_${ctx.h}_f_${slug(rest)}_${slug(asModule.id)}`, question: `${cap(aggWord === 'total' ? 'sum' : (aggWord as string))} of what in ${asModule.name}? Which number field?`, options: fieldsOf(asModule).filter((f) => isNumberField(f)).map((f) => f.label), why: WHY }, ctx.score)
        throw e
      }
    } else {
      const adj = adjectiveModule(ctx, rest)
      if (adj) {
        module = adj.module
        const numericFields = fieldsOf(module).filter((f) => isNumberField(f))
        const ranked = numericFields.map((f) => ({ f, s: Math.max(nameScore(adj.adj, f.label), nameScore(adj.adj, f.name)) })).filter((x) => x.s >= 60).sort((a, b) => b.s - a.s)
        const topFields = ranked.filter((x) => x.s === ranked[0]?.s)
        if (topFields.length === 1) {
          field = topFields[0].f
          agg = 'sum'
          ctx.assumptions.push(`“${cap(rest)}” is the total of ${module.name} → ${field.label}.`)
        } else if (topFields.length > 1) {
          field = fieldFor(ctx, module, adj.adj, 'number')
          agg = 'sum'
        } else {
          const choice = fieldsOf(module).find((f) => (f.type === 'dropdown' || f.type === 'radio') && (f.options ?? []).some((o) => labelEq(o.label, adj.adj) || labelEq(o.id, adj.adj)))
          if (!choice) field = fieldFor(ctx, module, adj.adj, 'number')
          else {
            const cf = { field: nameOf(choice), operator: 'equal' as Operator, value: optionFor(ctx, choice, adj.adj) }
            filters.push(cf)
            agg = 'count'
          }
        }
      } else {
        const a = across(ctx, rest, 'any')
        module = a.module
        field = a.field
        agg = isNumberField(field) ? 'sum' : 'count'
        if (agg === 'count') field = undefined
      }
    }
  }
  if (!module) throw new Unsupported('no module')
  if (condText) filters.push(...asFilters(parseConditions(ctx, module, condText)))
  const range = rangeFor(ctx, module, preset)
  return { title, module, agg, field, filters, range }
}

// ---- calculations -------------------------------------------------------------------------------------------------

type CalcOp = 'add' | 'subtract' | 'multiply' | 'divide' | 'percentage'
interface Expr {
  op: CalcOp
  terms: string[]
  out?: string
  note?: string
}

const splitTerms = (s: string): string[] => s.split(/\s*,\s*|\s+and\s+|\s+plus\s+/i).map((x) => x.trim()).filter(Boolean)
const cleanTerm = (s: string): string => s.trim().replace(/^(?:the|a|an)\s+/i, '').replace(/[.]+$/, '').trim()

function parseExpr(s: string): Expr | undefined {
  let m: RegExpExecArray | null
  if ((m = /(?:the\s+)?percent(?:age)?\s+of\s+(.+?)\s+(?:out of|over|of|from|in)\s+(.+)$/i.exec(s))) return { op: 'percentage', terms: [m[1], m[2]].map(cleanTerm) }
  if ((m = /^(.+?)\s+as\s+a\s+percent(?:age)?\s+of\s+(.+)$/i.exec(s))) return { op: 'percentage', terms: [m[1], m[2]].map(cleanTerm) }
  if ((m = /subtract(?:ing)?\s+(.+?)\s+from\s+(.+)$/i.exec(s))) return { op: 'subtract', terms: [m[2], m[1]].map(cleanTerm) }
  if ((m = /subtract(?:ing)?\s+(.+?)\s+(?:and|,)\s+(.+)$/i.exec(s))) return { op: 'subtract', terms: [m[1], m[2]].map(cleanTerm), note: 'Subtracting “A and B” is read as A minus B.' }
  if ((m = /(?:^|\s)(?:add|adding)\s+(.+?)\s+to\s+(.+)$/i.exec(s))) return { op: 'add', terms: [m[1], m[2]].map(cleanTerm) }
  if ((m = /(?:^|\s)(?:add|adding|sum(?:ming)?(?: up)?)\s+(.+)$/i.exec(s))) return { op: 'add', terms: splitTerms(m[1]).map(cleanTerm) }
  if ((m = /multipl(?:y|ying|ied)\s+(.+?)\s+(?:by|and|with|times)\s+(.+)$/i.exec(s))) return { op: 'multiply', terms: [m[1], m[2]].map(cleanTerm) }
  if ((m = /divid(?:e|ing|ed)\s+(.+?)\s+(?:by|and)\s+(.+)$/i.exec(s))) return { op: 'divide', terms: [m[1], m[2]].map(cleanTerm) }
  const infix: [RegExp, CalcOp][] = [[/\s(?:minus|less)\s|\s-\s/i, 'subtract'], [/\s(?:plus)\s|\s\+\s/i, 'add'], [/\s(?:times|multiplied by|x)\s|\s\*\s/i, 'multiply'], [/\s(?:divided by|over)\s|\s\/\s/i, 'divide']]
  const found = infix.filter(([re]) => re.test(s))
  if (found.length > 1) throw new Unsupported('That mixes several operations (for example plus and minus). Say it one operation at a time, or use the JSON editor.')
  if (found.length === 1) {
    const [re, op] = found[0]
    const terms = s.split(new RegExp(re.source, 'gi')).map(cleanTerm).filter(Boolean)
    if (terms.length >= 2) return { op, terms }
  }
  return undefined
}

function parseCalculation(ctx: Ctx, request: string, body: string): NlDraft {
  let s = body.replace(/^(?:please\s+|can you\s+|could you\s+|i want to\s+|i'd like to\s+|i need to\s+)*(?:automatically\s+|auto-?\s*)?(?:calculate|compute|work out|create a calculation(?: for| that calculates| to calculate)?|add a calculated field(?: called| named| for)?|add a calculation(?: for| to calculate)?)\s*/i, '').replace(/[.?!]+$/, '').trim()
  s = s.replace(/^(?:the|a|an)\s+/i, '')
  // output phrase: everything before the connector that introduces the expression
  const split = /^(.*?)\s+(?:=|as|by|from|using|equals?|is|:)\s+(.+)$/i.exec(s)
  let expr: Expr | undefined
  let outPhrase: string | undefined
  if (split) {
    const e = parseExpr(split[2])
    if (e && !/^(?:subtract|add|multipl|divid)/i.test(split[1])) {
      expr = e
      outPhrase = split[1]
    }
  }
  if (!expr) {
    expr = parseExpr(s)
    if (expr && /^(?:subtract|add|multipl|divid|percent)/i.test(s)) outPhrase = undefined
  }
  if (!expr) {
    // an aggregate: "total paid amount in fees this month"
    if (AGG_RE.test(s.replace(/^(?:the)\s+/i, ''))) return aggregateCalculation(ctx, s)
    throw new Unsupported('I could not tell what to calculate. Try “calculate X by subtracting A from B”, or “total of F in M this month”.')
  }
  const e = expr
  const { module, value } = inModule(ctx, request, (m, c) => {
    const inputs: Input[] = e.terms.map((term) => {
      const n = parseNum(term)
      if (n !== undefined) return { value: n }
      const f = fieldFor(c, m, term, 'number')
      return e.op === 'add' || e.op === 'subtract' ? { field: nameOf(f), default: 0 } : { field: nameOf(f) }
    })
    if (e.terms.length < 2 && e.op !== 'add') throw new Unsupported('That needs two values.')
    if (!inputs.some((i) => 'field' in i)) throw new Unsupported('That does not read any field.')
    return inputs
  })
  const inputs = value
  let outLabel = outPhrase ? cap(cleanTerm(outPhrase).replace(/\s+field$/i, '')) : undefined
  if (!outLabel) {
    const id = `nl_${ctx.h}_out`
    const a = answerOf(ctx, id)
    if (!a) throw new Clarify({ id, question: 'What should the result be called? It is saved in a new calculated field.', options: e.op === 'percentage' ? ['Percentage'] : e.op === 'subtract' ? ['Balance', 'Difference', 'Result'] : ['Result'], why: 'The result needs a field to live in.' }, ctx.score)
    outLabel = cap(unquote(a))
  }
  const existing = module.fields.find((f) => nameScore(outLabel!, f.label) === 100 || slug(f.name) === slug(outLabel!))
  let outName = slug(outLabel)
  if (existing) {
    if (existing.calculated) outName = nameOf(existing)
    else {
      outLabel = `${existing.label} (calculated)`
      outName = slug(outLabel)
      ctx.assumptions.push(`“${existing.label}” is a field people type into, so the result goes into a new calculated field called “${outLabel}”.`)
    }
  }
  if (e.note) ctx.assumptions.push(e.note)
  if (e.op === 'subtract' || e.op === 'add') ctx.assumptions.push('A blank value counts as 0.')
  const body2: CalculationBody = {
    type: 'calculation',
    name: `Calculate ${outLabel}`,
    entity: module.id,
    output_field: outName,
    operation: e.op,
    inputs,
    trigger: 'on_record_change',
    ...(e.op === 'percentage' ? { output: { label: outLabel, type: 'percentage' as const } } : { output: { label: outLabel } }),
  }
  const names = inputs.map((i) => ('field' in i ? module.fields.find((f) => nameOf(f) === i.field)?.label : 'value' in i ? String(i.value) : '')).filter(Boolean)
  const verb: Record<CalcOp, string> = { add: names.join(' + '), subtract: names.join(' − '), multiply: names.join(' × '), divide: names.join(' ÷ '), percentage: `${names[0]} as a percentage of ${names[1]}` }
  return { kind: 'draft', configKind: 'calculations', body: body2, entity: module.id, summary: `In ${module.name}, ${outLabel} = ${verb[e.op]}. It is recalculated whenever a record changes.`, assumptions: dedupe(ctx.assumptions) }
}

function aggregateCalculation(ctx: Ctx, text: string): NlDraft {
  const m = parseMetric(ctx, text)
  const name = m.title
  const op = m.agg === 'count' ? (m.filters.length ? 'count' : 'count') : m.agg
  const body: CalculationBody = {
    type: 'calculation',
    name,
    entity: m.module.id,
    scope: 'aggregate',
    operation: op,
    ...(m.field ? { inputs: [{ field: nameOf(m.field) }] } : {}),
    ...(m.filters.length ? { filters: m.filters } : {}),
    ...(m.range ? { dateRange: m.range } : {}),
  }
  const what = m.agg === 'count' ? `the number of ${m.module.name} records` : `the ${m.agg === 'sum' ? 'total' : m.agg} of ${m.field?.label} in ${m.module.name}`
  const extra = (m.filters.length ? ' that match your condition' : '') + (m.range ? ` for ${typeof m.range === 'string' ? m.range.replace(/_/g, ' ') : m.range.preset.replace(/_/g, ' ')}` : '')
  return { kind: 'draft', configKind: 'calculations', body, entity: m.module.id, summary: `Calculates ${what}${extra}. It is a value you can show on a dashboard.`, assumptions: dedupe(ctx.assumptions) }
}

const dedupe = (a: string[]): string[] => [...new Set(a)]

// ---- rules --------------------------------------------------------------------------------------------------------

interface Branch {
  condition?: string
  action: string
}

function branchesOf(text: string): Branch[] {
  const t = text.replace(/^(?:please\s+)?(?:create|add)\s+(?:a\s+)?rule\s*(?:that|to|:|,)?\s*/i, '').replace(/^rule\s*[:,]\s*/i, '').trim()
  const parts = t.split(/(?:^|[.;]\s*|,\s*|\s+)(?=(?:if|when|whenever|otherwise|else|elif)\b)/i).map((x) => x.trim()).filter(Boolean)
  const out: Branch[] = []
  for (const p of parts) {
    const kw = /^(otherwise|else|elif)\b[\s,:]*(.*)$/i.exec(p)
    if (kw) {
      const restText = kw[2].trim()
      if (!restText) continue // a lone "else" / "otherwise": the "if" that follows is the next branch
      if (/^(?:if|when|whenever)\b/i.test(restText)) {
        out.push(...branchesOf(restText))
        continue
      }
      out.push({ action: restText.replace(/[.]+$/, '') })
      continue
    }
    const m = /^(?:if|when|whenever)\s+(.+?)(?:\s*,\s*then\s+|\s+then\s+|\s*,\s*(?=(?:set|mark|change|update|make)\b)|\s+(?=(?:set|mark|change|update)\b))(.+)$/i.exec(p)
    if (!m) throw new Unsupported(`I could not split “${p}” into a condition and an action. Try “If … then set … to …”.`)
    out.push({ condition: m[1].trim(), action: m[2].trim().replace(/[.]+$/, '') })
  }
  if (!out.length) throw new Unsupported('I could not find an “if … then …” in that request.')
  return out
}

function statusFieldOf(module: Module): Field | undefined {
  const choices = fieldsOf(module).filter((f) => f.type === 'dropdown' || f.type === 'radio')
  return choices.find((f) => /status|stage/i.test(f.name) || /status|stage/i.test(f.label)) ?? (choices.length === 1 ? choices[0] : undefined)
}

function parseActions(ctx: Ctx, module: Module, text: string): Action[] {
  const pieces = text.split(/\s*,?\s+(?:and|also)\s+(?=(?:also\s+)?(?:set|mark|change|update|make)\b)|\s*,\s*(?=(?:set|mark|change|update|make)\b)/i).map((x) => x.trim()).filter(Boolean)
  return pieces.map((p) => {
    let m = /^(?:set|change|update|make)\s+(?:the\s+)?(.+?)\s+(?:to|as|=|be)\s+(.+)$/i.exec(p)
    if (m) {
      const field = fieldFor(ctx, module, m[1], 'any')
      const v = unquote(m[2])
      if (field.type === 'dropdown' || field.type === 'radio') return { type: 'set_status' as const, field: nameOf(field), value: optionFor(ctx, field, v) }
      if (field.type === 'yesNo') {
        if (/^(yes|true|checked|on)$/i.test(v)) return { type: 'update_field' as const, field: nameOf(field), value: true }
        if (/^(no|false|unchecked|off)$/i.test(v)) return { type: 'update_field' as const, field: nameOf(field), value: false }
        throw new Unsupported(`"${v}" is not yes or no`)
      }
      if (isNumberField(field)) {
        const n = parseNum(v)
        return { type: 'update_field' as const, field: nameOf(field), value: n !== undefined ? n : refOf(fieldFor(ctx, module, v, 'number')) }
      }
      if (isDateField(field)) return { type: 'update_field' as const, field: nameOf(field), value: /^(today|now)$/i.test(v) ? 'today' : v }
      return { type: 'update_field' as const, field: nameOf(field), value: v }
    }
    m = /^(?:mark|set|change)\s+(?:it\s+|the record\s+|this\s+)?(?:as\s+|to\s+)?(.+)$/i.exec(p)
    const valuePhrase = m ? m[1] : p
    const status = statusFieldOf(module)
    if (!status) throw new Clarify({ id: `nl_${ctx.h}_status_${slug(module.id)}`, question: `Which field should “${unquote(valuePhrase)}” be set on in ${module.name}?`, options: fieldsOf(module).filter((f) => f.type === 'dropdown' || f.type === 'radio').map((f) => f.label), why: WHY }, ctx.score)
    return { type: 'set_status' as const, field: nameOf(status), value: optionFor(ctx, status, valuePhrase) }
  })
}

function parseRule(ctx: Ctx, request: string, text: string): NlDraft {
  const branches = branchesOf(text)
  const { module, value: rules } = inModule(ctx, request, (m, c) => {
    const out: RuleItem[] = []
    let anchor: Field | undefined
    branches.forEach((b, i) => {
      const actions = parseActions(c, m, b.action)
      const action = actions[0]
      const label = action && action.type !== 'calculate' && action.type !== 'run_automation' ? (typeof action.value === 'string' ? action.value : `Rule ${i + 1}`) : `Rule ${i + 1}`
      if (b.condition) {
        const p = parseConditions(c, m, b.condition)
        const first = p.nodes[0] as { field?: string }
        if (!anchor && first?.field) anchor = fieldsOf(m).find((f) => nameOf(f) === first.field)
        out.push({ name: label, logic: p.logic, conditions: p.nodes, ...(actions.length === 1 ? { action } : { actions }) })
      } else {
        // "otherwise": a condition that is always true (the field is either empty or not), so the engine's first-match order does the rest
        const f = anchor ?? fieldsOf(m)[0]
        if (!f) throw new Unsupported(`${m.name} has no fields`)
        out.push({ name: 'Otherwise', logic: 'OR', conditions: [{ field: nameOf(f), operator: 'is_empty' }, { field: nameOf(f), operator: 'is_not_empty' }], ...(actions.length === 1 ? { action } : { actions }) })
      }
    })
    return out
  })
  const targets = [...new Set(rules.flatMap((r) => [...(r.action ? [r.action] : []), ...(r.actions ?? [])]).map((a) => ('field' in a && a.field ? a.field : '')))].filter(Boolean)
  const targetLabel = targets.length === 1 ? (module.fields.find((f) => nameOf(f) === targets[0])?.label ?? targets[0]) : 'fields'
  const body: ConditionalRuleBody = { type: 'conditional_rule', name: `${cap(targetLabel)} rule`, entity: module.id, trigger: 'on_record_change', mode: 'first_match', rules }
  if (rules.length > 1) ctx.assumptions.push('The first matching rule wins, in the order you wrote them.')
  if (rules.some((r) => r.name === 'Otherwise')) ctx.assumptions.push('“Otherwise” applies when none of the earlier conditions match.')
  return { kind: 'draft', configKind: 'conditional_rules', body, entity: module.id, summary: `In ${module.name}, ${rules.length === 1 ? 'when the condition is true,' : `${rules.length} rules decide`} ${targetLabel} ${rules.length === 1 ? 'is set automatically' : 'is set automatically (first match wins)'}.`, assumptions: dedupe(ctx.assumptions) }
}

// ---- dashboards ---------------------------------------------------------------------------------------------------

function splitItems(list: string): string[] {
  const out: string[] = []
  for (const chunk of list.split(/\s*[,;]\s*(?:and\s+)?/i)) {
    // "A and B": two items, unless B only continues the condition of A ("students with attendance below 75% and above 50%")
    const merged: string[] = []
    for (const part of chunk.split(/\s+and\s+/i)) {
      const prev = merged[merged.length - 1]
      const continues = prev !== undefined && /\b(?:with|where|whose|having)\b/i.test(prev) && !/\b(?:with|where|whose|having)\b/i.test(part) && findOperator(part) !== undefined && !AGG_RE.test(part)
      if (continues) merged[merged.length - 1] = `${prev} and ${part}`
      else merged.push(part)
    }
    out.push(...merged)
  }
  return out.map((x) => x.trim().replace(/[.]+$/, '')).filter(Boolean)
}

function widgetOf(m: Metric, index: number): DashboardWidgetShape {
  const f = m.field
  const format = f ? (f.type === 'currency' ? { kind: 'currency' as const, ...(f.currency ? { currency: f.currency } : {}) } : f.type === 'percentage' ? { kind: 'percent' as const } : { kind: 'number' as const }) : undefined
  const type: WidgetKind = m.agg === 'count' ? 'record_count' : m.agg === 'average' ? 'average' : 'kpi'
  return {
    id: `nl_w${index + 1}`,
    type,
    title: m.title,
    enabled: true,
    layout: { w: 1, h: 1, order: index },
    source: { entity: m.module.id, ...(f ? { field: nameOf(f) } : {}), aggregation: m.agg as Aggregation, ...(m.filters.length ? { filters: m.filters } : {}), ...(m.range ? { dateRange: m.range } : {}) },
    ...(format ? { format } : {}),
  }
}

function parseDashboard(ctx: Ctx, text: string): NlDraft {
  const named = /(?:called|named|titled)\s+["“]?([^"”,]+?)["”]?(?=\s+(?:showing|with|that|which|for|of)\b|$)/i.exec(text)
  const m = /\b(?:dashboard|overview)\b(?:\s+(?:showing|with|that shows|which shows|to show|displaying|containing|for|of|including))?\s*(.*)$/i.exec(text)
  let list = (m?.[1] ?? '').trim()
  if (named) list = list.replace(named[0], '').trim()
  list = list.replace(/^(?:called|named)\s+\S+\s*/i, '').replace(/^(?:showing|with|that shows|which shows|displaying|containing|including)\s+/i, '').trim()
  const items = splitItems(list)
  if (!items.length) throw new Unsupported('Say what the dashboard should show, for example “a dashboard showing total students and average attendance”.')
  const widgets = items.map((it, i) => widgetOf(parseMetric(ctx, it), i))
  const name = named ? cap(named[1].trim()) : 'Dashboard'
  const body: DashboardBody = { type: 'dashboard', name, widgets, enabled: true }
  return { kind: 'draft', configKind: 'dashboards', body, summary: `A dashboard “${name}” with ${widgets.length} widget${widgets.length === 1 ? '' : 's'}: ${widgets.map((w) => w.title).join(', ')}. Each one is computed from your real records.`, assumptions: dedupe(ctx.assumptions) }
}

// ---- entry ----------------------------------------------------------------------------------------------------------

const clean = (s: string): string => s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').replace(/[?!]+$/, '').trim()

/** Parse a request against the real modules. Pure and deterministic: the same input gives the same output. */
export function parseNl(request: string, modules: Module[], options: NlOptions = {}): NlResult {
  const text = clean(request)
  const shape = configureShape(text)
  if (!shape) return { kind: 'none', reason: 'This does not look like a calculation, a rule or a dashboard request.' }
  const usable = modules.filter((m) => !m.archived && !m.system)
  if (!usable.length) return { kind: 'none', reason: 'There are no modules yet, so there is nothing to calculate on.' }
  const ctx: Ctx = { modules: usable, answers: options.answers ?? {}, h: hashOf(text), assumptions: [], score: 0 }
  try {
    if (shape === 'dashboard') return parseDashboard(ctx, text)
    if (shape === 'rule') return parseRule(ctx, text, text)
    return parseCalculation(ctx, text, text)
  } catch (e) {
    if (e instanceof Clarify) return { kind: 'clarify', ...e.q }
    if (e instanceof Unsupported) return { kind: 'none', reason: e.message }
    throw e
  }
}
