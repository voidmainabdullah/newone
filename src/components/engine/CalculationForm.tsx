import { Plus, Trash2 } from 'lucide-react'
import type { Module } from '#/types'
import { OPERATIONS, PRESETS, TRIGGERS, UNITS, type CalculationBody, type ConditionNode, type Input as CalcInput, type Operation } from '#/engine/schema'
import { Field as FormField, Input, Select, Switch } from '#/components/ui/controls'
import { ConditionGroupEditor } from './ConditionEditor'

export const OPERATION_LABEL: Record<Operation, string> = {
  add: 'Add (a + b)',
  subtract: 'Subtract (a − b)',
  multiply: 'Multiply (a × b)',
  divide: 'Divide (a ÷ b)',
  percentage: 'Percentage (a as % of b)',
  percent_of: 'Percent of (a % of b)',
  average: 'Average of inputs',
  min: 'Smallest of inputs',
  max: 'Largest of inputs',
  count: 'Count',
  sum: 'Sum',
  count_if: 'Count records that match',
  sum_if: 'Sum records that match',
  date_diff: 'Days / months between two dates',
  date_add: 'Add time to a date',
  compare: 'Compare two values',
  if: 'If / then / else',
}

const LIST_OPS = new Set<Operation>(['add', 'subtract', 'multiply', 'divide', 'percentage', 'percent_of', 'average', 'min', 'max', 'sum', 'count', 'compare', 'count_if', 'sum_if', 'date_diff', 'date_add'])
const FILTER_OPS = new Set<Operation>(['count_if', 'sum_if', 'sum', 'count', 'average', 'min', 'max'])

const fieldsOf = (m: Module) => m.fields.filter((f) => !['password', 'file', 'image', 'document', 'signature', 'longText'].includes(f.type))

function InputRow({ module, input, onChange, onRemove, label, disabled }: { module: Module; input: CalcInput; onChange: (i: CalcInput) => void; onRemove?: () => void; label: string; disabled?: boolean }) {
  const kind = 'field' in input ? 'field' : 'value' in input ? 'value' : 'calc'
  const fields = fieldsOf(module)
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Select aria-label={`${label} type`} disabled={disabled || kind === 'calc'} value={kind} onChange={(e) => onChange(e.target.value === 'field' ? { field: fields[0]?.id ?? '' } : { value: 0 })} className="h-8 w-28 text-[13px]">
        <option value="field">Field</option>
        <option value="value">Number</option>
        {kind === 'calc' && <option value="calc">Nested</option>}
      </Select>
      {'field' in input && (
        <>
          <Select aria-label={`${label} field`} disabled={disabled} value={fields.find((f) => f.id === input.field || f.name === input.field)?.id ?? input.field} onChange={(e) => onChange({ ...input, field: e.target.value })} className="h-8 min-w-0 flex-1 text-[13px]">
            {!fields.some((f) => f.id === input.field || f.name === input.field) && <option value={input.field}>{input.field}</option>}
            {fields.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </Select>
          <Input aria-label={`${label} default when blank`} disabled={disabled} type="number" placeholder="default" title="Used when the field is blank" value={input.default ?? ''} onChange={(e) => onChange({ field: input.field, ...(e.target.value === '' ? {} : { default: Number(e.target.value) }) })} className="h-8 w-24 text-[13px]" />
        </>
      )}
      {'value' in input && <Input aria-label={`${label} value`} disabled={disabled} type="number" value={input.value === null ? '' : String(input.value)} onChange={(e) => onChange({ value: e.target.value === '' ? 0 : Number(e.target.value) })} className="h-8 min-w-0 flex-1 text-[13px]" />}
      {kind === 'calc' && <span className="flex-1 text-xs text-muted">A nested calculation (edit it in the JSON tab)</span>}
      {onRemove && <button type="button" aria-label={`Remove ${label}`} disabled={disabled} onClick={onRemove} className="rounded p-1.5 text-muted hover:bg-danger/10 hover:text-danger disabled:opacity-40"><Trash2 size={14} /></button>}
    </div>
  )
}

/** The guided form for a calculation. Settings it has no control for (nested calculations, related records) are kept untouched. */
export function CalculationForm({ module, body, onChange, disabled }: { module: Module; body: CalculationBody; onChange: (b: CalculationBody) => void; disabled?: boolean }) {
  const set = (patch: Partial<CalculationBody>) => onChange({ ...body, ...patch })
  const inputs = body.inputs ?? []
  const op = body.operation
  const aggregate = body.scope === 'aggregate'
  const filters: ConditionNode[] = body.filters ?? []
  const preset = typeof body.dateRange === 'object' ? body.dateRange.preset : (body.dateRange ?? 'all')
  const dateFields = module.fields.filter((f) => f.type === 'date' || f.type === 'datetime')
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Name" required><Input disabled={disabled} value={body.name} onChange={(e) => set({ name: e.target.value })} /></FormField>
        <FormField label="What it calculates">
          <Select aria-label="Operation" disabled={disabled} value={op} onChange={(e) => set({ operation: e.target.value as Operation })}>
            {OPERATIONS.map((o) => <option key={o} value={o}>{OPERATION_LABEL[o]}</option>)}
          </Select>
        </FormField>
        <FormField label="Result" hint={aggregate ? 'One number (or a series) for the whole module.' : 'Saved on every record in a read-only field.'}>
          <Select aria-label="Scope" disabled={disabled} value={aggregate ? 'aggregate' : 'record'} onChange={(e) => set({ scope: e.target.value as 'record' | 'aggregate' })}>
            <option value="record">One value per record</option>
            <option value="aggregate">One value for the whole module</option>
          </Select>
        </FormField>
        {!aggregate && (
          <FormField label="Save result in field" hint="An existing field, or a new name (it is created as a calculated field).">
            <Input aria-label="Output field" disabled={disabled} list={`out-${module.id}`} value={body.output_field ?? ''} onChange={(e) => set({ output_field: e.target.value })} />
            <datalist id={`out-${module.id}`}>{module.fields.filter((f) => ['number', 'currency', 'percentage', 'date'].includes(f.type)).map((f) => <option key={f.id} value={f.name}>{f.label}</option>)}</datalist>
          </FormField>
        )}
      </div>

      {op === 'if' ? (
        <div className="space-y-3">
          <ConditionGroupEditor module={module} label="If" disabled={disabled} value={{ logic: 'AND', nodes: body.condition ? [body.condition] : [] }} onChange={(g) => set({ condition: g.nodes.length === 1 ? g.nodes[0] : { logic: g.logic, conditions: g.nodes } })} />
          <div className="space-y-1.5"><div className="text-xs font-medium text-muted">Then</div><InputRow module={module} label="Then" input={body.then ?? { value: 0 }} disabled={disabled} onChange={(i) => set({ then: i })} /></div>
          <div className="space-y-1.5"><div className="text-xs font-medium text-muted">Otherwise</div><InputRow module={module} label="Otherwise" input={body.else ?? { value: 0 }} disabled={disabled} onChange={(i) => set({ else: i })} /></div>
        </div>
      ) : (
        LIST_OPS.has(op) && (
          <div className="space-y-1.5">
            <div className="text-xs font-medium text-muted">Inputs</div>
            {inputs.map((inp, i) => <InputRow key={i} module={module} label={`Input ${i + 1}`} input={inp} disabled={disabled} onChange={(n) => set({ inputs: inputs.map((x, j) => (j === i ? n : x)) })} onRemove={inputs.length > 1 ? () => set({ inputs: inputs.filter((_, j) => j !== i) }) : undefined} />)}
            <button type="button" disabled={disabled} onClick={() => set({ inputs: [...inputs, { field: fieldsOf(module)[0]?.id ?? '' }] })} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-link hover:bg-subtle disabled:opacity-40"><Plus size={12} /> Add input</button>
          </div>
        )
      )}

      {(op === 'date_diff' || op === 'date_add') && (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Unit"><Select aria-label="Unit" disabled={disabled} value={body.unit ?? 'days'} onChange={(e) => set({ unit: e.target.value as CalculationBody['unit'] })}>{UNITS.map((u) => <option key={u} value={u}>{u}</option>)}</Select></FormField>
          {op === 'date_add' && <FormField label="Amount"><Input aria-label="Amount" disabled={disabled} type="number" value={typeof body.amount === 'number' ? body.amount : ''} onChange={(e) => set({ amount: Number(e.target.value) })} /></FormField>}
        </div>
      )}

      {FILTER_OPS.has(op) && (aggregate || op === 'count_if' || op === 'sum_if') && (
        <ConditionGroupEditor module={module} label="Only records where" disabled={disabled} value={{ logic: 'AND', nodes: filters }} onChange={(g) => set({ filters: g.logic === 'OR' && g.nodes.length > 1 ? [{ logic: 'OR', conditions: g.nodes }] : g.nodes })} />
      )}

      {aggregate && (
        <div className="grid gap-3 sm:grid-cols-3">
          <FormField label="Group by">
            <Select aria-label="Group by" disabled={disabled} value={body.groupBy ?? ''} onChange={(e) => set({ groupBy: e.target.value || undefined })}>
              <option value="">No grouping</option>
              {module.fields.filter((f) => ['dropdown', 'radio', 'yesNo', 'user', 'relationship', 'date', 'datetime'].includes(f.type)).map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </Select>
          </FormField>
          <FormField label="Period">
            <Select aria-label="Period" disabled={disabled} value={preset} onChange={(e) => set({ dateRange: e.target.value === 'all' ? undefined : (e.target.value as (typeof PRESETS)[number]) })}>
              {PRESETS.filter((p) => p !== 'custom').map((p) => <option key={p} value={p}>{p.replace(/_/g, ' ')}</option>)}
            </Select>
          </FormField>
          <FormField label="Period date field"><Select aria-label="Date field" disabled={disabled || preset === 'all'} value={typeof body.dateRange === 'object' ? (body.dateRange.field ?? '') : ''} onChange={(e) => set({ dateRange: { preset: preset as (typeof PRESETS)[number], ...(e.target.value ? { field: e.target.value } : {}) } })}><option value="">Created date</option>{dateFields.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</Select></FormField>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <FormField label="Runs">
          <Select aria-label="Trigger" disabled={disabled} value={body.trigger ?? 'on_record_change'} onChange={(e) => set({ trigger: e.target.value as CalculationBody['trigger'] })}>
            {TRIGGERS.map((t) => <option key={t} value={t}>{{ on_record_change: 'When a record changes', schedule: 'On a schedule', manual: 'Only when I ask' }[t]}</option>)}
          </Select>
        </FormField>
        <FormField label="Decimal places"><Input aria-label="Decimal places" disabled={disabled} type="number" min={0} max={12} value={body.precision ?? ''} onChange={(e) => set({ precision: e.target.value === '' ? undefined : Number(e.target.value) })} /></FormField>
        <div className="flex items-end pb-1"><Switch disabled={disabled} checked={body.enabled !== false} onChange={(v) => set({ enabled: v })} label="Enabled" /></div>
      </div>
    </div>
  )
}
