import { Plus, Trash2 } from 'lucide-react'
import type { Field, Module } from '#/types'
import { operatorsFor } from '#/engine/rules'
import { isGroup, type Condition, type ConditionGroup, type ConditionNode, type OperandValue, type Operator } from '#/engine/schema'
import { Select, Input } from '#/components/ui/controls'
import { Segmented } from '#/components/ui/misc'
import { cn } from '#/utils/id'

export const OPERATOR_LABEL: Record<Operator, string> = {
  equal: 'is',
  not_equal: 'is not',
  greater_than: 'is greater than',
  less_than: 'is less than',
  greater_than_or_equal: 'is at least',
  less_than_or_equal: 'is at most',
  contains: 'contains',
  not_contains: 'does not contain',
  is_empty: 'is empty',
  is_not_empty: 'is not empty',
  is_true: 'is yes',
  is_false: 'is no',
  between: 'is between',
  before: 'is before',
  after: 'is after',
  in: 'is one of',
  not_in: 'is none of',
}

const NO_VALUE = new Set<Operator>(['is_empty', 'is_not_empty', 'is_true', 'is_false'])
const LIST = new Set<Operator>(['in', 'not_in'])

const isFieldRef = (v: unknown): v is { field: string } => !!v && typeof v === 'object' && !Array.isArray(v) && 'field' in v
const text = (v: unknown): string => (v === null || v === undefined || isFieldRef(v) || Array.isArray(v) ? '' : String(v))

/** the fields a condition can test (the calculated ones too: a rule may read a computed amount) */
const testable = (m: Module): Field[] => m.fields.filter((f) => !['password', 'file', 'image', 'document', 'signature'].includes(f.type))

function inputType(f: Field | undefined): string {
  if (!f) return 'text'
  if (f.type === 'date') return 'date'
  if (f.type === 'datetime') return 'datetime-local'
  if (['number', 'currency', 'percentage', 'rating'].includes(f.type)) return 'number'
  return 'text'
}

/** the value box for ONE literal of the field's kind */
export function LiteralInput({ field, value, onChange, label, disabled }: { field?: Field; value: unknown; onChange: (v: string | number) => void; label: string; disabled?: boolean }) {
  if (field && field.options?.length && (field.type === 'dropdown' || field.type === 'radio')) {
    return (
      <Select aria-label={label} disabled={disabled} value={text(value)} onChange={(e) => onChange(e.target.value)} className="h-8 text-[13px]">
        <option value="">Choose…</option>
        {field.options.map((o) => <option key={o.id} value={o.label}>{o.label}</option>)}
      </Select>
    )
  }
  const type = inputType(field)
  return <Input aria-label={label} disabled={disabled} type={type} value={text(value)} onChange={(e) => onChange(type === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value)} className="h-8 text-[13px]" />
}

/** an operand: a typed-in value, or "the value of another field of the same record" */
export function OperandEditor({ module, field, value, onChange, disabled }: { module: Module; field?: Field; value: OperandValue | undefined; onChange: (v: OperandValue) => void; disabled?: boolean }) {
  const fromField = isFieldRef(value)
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      <Segmented<'value' | 'field'> options={[{ id: 'value', label: 'Value' }, { id: 'field', label: 'Field' }]} value={fromField ? 'field' : 'value'} onChange={(m) => onChange(m === 'field' ? { field: testable(module).find((f) => f.id !== field?.id)?.id ?? '' } : '')} />
      {fromField ? (
        <Select aria-label="Compare with field" disabled={disabled} value={(value as { field: string }).field} onChange={(e) => onChange({ field: e.target.value })} className="h-8 min-w-0 flex-1 text-[13px]">
          {testable(module).map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
        </Select>
      ) : (
        <div className="min-w-0 flex-1"><LiteralInput field={field} label="Value" disabled={disabled} value={value} onChange={onChange} /></div>
      )}
    </div>
  )
}

function ConditionRow({ module, node, onChange, onRemove, disabled }: { module: Module; node: Condition; onChange: (c: Condition) => void; onRemove: () => void; disabled?: boolean }) {
  const fields = testable(module)
  const field = fields.find((f) => f.id === node.field) ?? fields.find((f) => f.name === node.field)
  const ops = field ? operatorsFor(field) : []
  const setField = (id: string) => {
    const f = fields.find((x) => x.id === id)
    const nextOps = f ? operatorsFor(f) : []
    // keep the operator when the new field supports it, otherwise fall back to the first sensible one
    const operator = nextOps.includes(node.operator) ? node.operator : (nextOps[0] ?? 'equal')
    onChange({ field: id, operator, ...(NO_VALUE.has(operator) ? {} : { value: '' }) })
  }
  const setOp = (operator: Operator) => {
    if (NO_VALUE.has(operator)) return onChange({ field: node.field, operator })
    if (operator === 'between') return onChange({ field: node.field, operator, value: ['', ''] })
    if (LIST.has(operator)) return onChange({ field: node.field, operator, value: Array.isArray(node.value) ? node.value : [] })
    onChange({ field: node.field, operator, value: Array.isArray(node.value) ? '' : (node.value ?? '') })
  }
  const pair = Array.isArray(node.value) ? node.value : ['', '']
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-line bg-surface p-1.5">
      <Select aria-label="Field" disabled={disabled} value={field?.id ?? ''} onChange={(e) => setField(e.target.value)} className="h-8 w-40 text-[13px]">
        {!field && <option value="">{node.field || 'Choose field'}</option>}
        {fields.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
      </Select>
      <Select aria-label="Operator" disabled={disabled || !field} value={node.operator} onChange={(e) => setOp(e.target.value as Operator)} className="h-8 w-36 text-[13px]">
        {(ops.length ? ops : [node.operator]).map((o) => <option key={o} value={o}>{OPERATOR_LABEL[o]}</option>)}
      </Select>
      {node.operator === 'between' ? (
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <div className="min-w-0 flex-1"><LiteralInput field={field} label="From" disabled={disabled} value={pair[0]} onChange={(v) => onChange({ ...node, value: [v, pair[1] ?? ''] as OperandValue })} /></div>
          <span className="text-xs text-muted">and</span>
          <div className="min-w-0 flex-1"><LiteralInput field={field} label="To" disabled={disabled} value={pair[1]} onChange={(v) => onChange({ ...node, value: [pair[0] ?? '', v] as OperandValue })} /></div>
        </div>
      ) : LIST.has(node.operator) ? (
        <Input aria-label="Values, separated by commas" disabled={disabled} placeholder="a, b, c" value={Array.isArray(node.value) ? node.value.map(text).join(', ') : ''} onChange={(e) => onChange({ ...node, value: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} className="h-8 min-w-0 flex-1 text-[13px]" />
      ) : NO_VALUE.has(node.operator) ? (
        <span className="flex-1" />
      ) : (
        <OperandEditor module={module} field={field} value={node.value} disabled={disabled} onChange={(v) => onChange({ ...node, value: v })} />
      )}
      <button type="button" aria-label="Remove condition" disabled={disabled} onClick={onRemove} className="rounded p-1.5 text-muted hover:bg-danger/10 hover:text-danger disabled:opacity-40"><Trash2 size={14} /></button>
    </div>
  )
}

export interface GroupValue {
  logic: 'AND' | 'OR'
  nodes: ConditionNode[]
}

/**
 * AND / OR groups of conditions, nested as deep as needed. The operator list follows the field's type (a date gets
 * before / after, a yes/no gets is yes / is no); the value can be typed in or taken from another field of the record.
 */
export function ConditionGroupEditor({ module, value, onChange, depth = 0, onRemove, disabled, label = 'Conditions' }: { module: Module; value: GroupValue; onChange: (v: GroupValue) => void; depth?: number; onRemove?: () => void; disabled?: boolean; label?: string }) {
  const first = testable(module)[0]
  const add = () => first && onChange({ ...value, nodes: [...value.nodes, { field: first.id, operator: operatorsFor(first)[0], value: '' }] })
  const addGroup = () => first && onChange({ ...value, nodes: [...value.nodes, { logic: 'AND', conditions: [{ field: first.id, operator: operatorsFor(first)[0], value: '' }] }] })
  const set = (i: number, n: ConditionNode) => onChange({ ...value, nodes: value.nodes.map((x, j) => (j === i ? n : x)) })
  const drop = (i: number) => onChange({ ...value, nodes: value.nodes.filter((_, j) => j !== i) })
  return (
    <div className={cn('space-y-1.5 rounded-xl', depth > 0 && 'border border-dashed border-line-strong p-2')} role="group" aria-label={depth ? 'Condition group' : label}>
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted">{depth ? 'Group' : label}</span>
        <Segmented<'AND' | 'OR'> options={[{ id: 'AND', label: 'All of' }, { id: 'OR', label: 'Any of' }]} value={value.logic} onChange={(logic) => onChange({ ...value, logic })} />
        {onRemove && <button type="button" aria-label="Remove group" disabled={disabled} onClick={onRemove} className="ml-auto rounded p-1 text-muted hover:bg-danger/10 hover:text-danger"><Trash2 size={14} /></button>}
      </div>
      {value.nodes.length === 0 && <p className="rounded-lg border border-dashed border-line px-3 py-2 text-xs text-muted">{depth ? 'Empty group.' : 'No conditions: this applies to every record.'}</p>}
      {value.nodes.map((n, i) =>
        isGroup(n) ? (
          <ConditionGroupEditor key={i} module={module} depth={depth + 1} disabled={disabled} value={{ logic: n.logic ?? 'AND', nodes: n.conditions }} onChange={(g) => set(i, { logic: g.logic, conditions: g.nodes } as ConditionGroup)} onRemove={() => drop(i)} />
        ) : (
          <ConditionRow key={i} module={module} node={n} disabled={disabled} onChange={(c) => set(i, c)} onRemove={() => drop(i)} />
        ),
      )}
      <div className="flex gap-1.5">
        <button type="button" disabled={disabled || !first} onClick={add} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-link hover:bg-subtle disabled:opacity-40"><Plus size={12} /> Add condition</button>
        {depth < 3 && <button type="button" disabled={disabled || !first} onClick={addGroup} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-link hover:bg-subtle disabled:opacity-40"><Plus size={12} /> Add group</button>}
      </div>
    </div>
  )
}
