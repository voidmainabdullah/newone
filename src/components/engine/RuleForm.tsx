import { Plus, Trash2 } from 'lucide-react'
import type { Module, Workflow } from '#/types'
import { RULE_TRIGGERS, type Action, type Calculation, type ConditionalRuleBody, type ConditionNode, type RuleItem } from '#/engine/schema'
import { actionsOf, statusFieldOf } from '#/engine/rules'
import { Field as FormField, Input, Select, Switch } from '#/components/ui/controls'
import { ConditionGroupEditor, LiteralInput, OperandEditor } from './ConditionEditor'

const ACTION_LABEL: Record<Action['type'], string> = { update_field: 'Set a field', set_status: 'Set the status', calculate: 'Run a calculation', run_automation: 'Run a workflow' }

const writable = (m: Module) => m.fields.filter((f) => !f.calculated && !['formula', 'autoId', 'file', 'image', 'document', 'signature', 'password'].includes(f.type))

function ActionRow({ module, action, calcs, workflows, onChange, onRemove, disabled }: { module: Module; action: Action; calcs: Calculation[]; workflows: Pick<Workflow, 'id' | 'name'>[]; onChange: (a: Action) => void; onRemove: () => void; disabled?: boolean }) {
  const fields = writable(module)
  const status = statusFieldOf(module)
  const switchTo = (type: Action['type']) => {
    if (type === 'update_field') onChange({ type, field: fields[0]?.id ?? '', value: '' })
    else if (type === 'set_status') onChange({ type, value: status?.options?.[0]?.label ?? '' })
    else if (type === 'calculate') onChange({ type, calculation: calcs[0]?.name ?? '' })
    else onChange({ type, workflow_id: workflows[0]?.id ?? '' })
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-line bg-surface p-1.5">
      <Select aria-label="Action" disabled={disabled} value={action.type} onChange={(e) => switchTo(e.target.value as Action['type'])} className="h-8 w-40 text-[13px]">
        {(Object.keys(ACTION_LABEL) as Action['type'][]).map((t) => <option key={t} value={t}>{ACTION_LABEL[t]}</option>)}
      </Select>
      {action.type === 'update_field' && (
        <>
          <Select aria-label="Field to set" disabled={disabled} value={action.field} onChange={(e) => onChange({ ...action, field: e.target.value })} className="h-8 w-40 text-[13px]">
            {fields.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </Select>
          <span className="text-xs text-muted">to</span>
          <OperandEditor module={module} field={fields.find((f) => f.id === action.field)} value={action.value} disabled={disabled} onChange={(v) => onChange({ ...action, value: v })} />
        </>
      )}
      {action.type === 'set_status' && (
        <>
          <span className="text-xs text-muted">{status ? status.label : 'status'} →</span>
          <div className="min-w-0 flex-1"><LiteralInput field={status} label="Status" disabled={disabled} value={action.value} onChange={(v) => onChange({ ...action, value: String(v) })} /></div>
        </>
      )}
      {action.type === 'calculate' && (
        <Select aria-label="Calculation" disabled={disabled} value={action.calculation} onChange={(e) => onChange({ ...action, calculation: e.target.value })} className="h-8 min-w-0 flex-1 text-[13px]">
          {calcs.length === 0 && <option value="">No saved calculations</option>}
          {calcs.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
        </Select>
      )}
      {action.type === 'run_automation' && (
        <Select aria-label="Workflow" disabled={disabled} value={action.workflow_id} onChange={(e) => onChange({ ...action, workflow_id: e.target.value })} className="h-8 min-w-0 flex-1 text-[13px]">
          {workflows.length === 0 && <option value="">No workflows in this project</option>}
          {workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </Select>
      )}
      <button type="button" aria-label="Remove action" disabled={disabled} onClick={onRemove} className="rounded p-1.5 text-muted hover:bg-danger/10 hover:text-danger disabled:opacity-40"><Trash2 size={14} /></button>
    </div>
  )
}

function RuleCard({ module, rule, index, calcs, workflows, onChange, onRemove, disabled }: { module: Module; rule: RuleItem; index: number; calcs: Calculation[]; workflows: Pick<Workflow, 'id' | 'name'>[]; onChange: (r: RuleItem) => void; onRemove?: () => void; disabled?: boolean }) {
  const actions = actionsOf(rule)
  // the guided form always writes `actions` (the list); a single `action` from JSON is folded into it
  const setActions = (list: Action[]) => {
    const { action: _a, ...rest } = rule
    onChange({ ...rest, actions: list })
  }
  return (
    <section className="space-y-3 rounded-xl border border-line p-3" aria-label={`Rule ${index + 1}`}>
      <div className="flex items-center gap-2">
        <span className="rounded-md bg-subtle px-2 py-0.5 text-xs font-semibold">{index + 1}</span>
        <Input aria-label="Rule name" disabled={disabled} value={rule.name ?? ''} placeholder={`Rule ${index + 1}`} onChange={(e) => onChange({ ...rule, name: e.target.value })} className="h-8 flex-1 text-[13px]" />
        {onRemove && <button type="button" aria-label="Remove rule" disabled={disabled} onClick={onRemove} className="rounded p-1.5 text-muted hover:bg-danger/10 hover:text-danger disabled:opacity-40"><Trash2 size={14} /></button>}
      </div>
      <ConditionGroupEditor module={module} label="When" disabled={disabled} value={{ logic: rule.logic ?? 'AND', nodes: rule.conditions as ConditionNode[] }} onChange={(g) => onChange({ ...rule, logic: g.logic, conditions: g.nodes })} />
      <div className="space-y-1.5">
        <div className="text-xs font-medium text-muted">Then</div>
        {actions.length === 0 && <p className="rounded-lg border border-dashed border-line px-3 py-2 text-xs text-muted">Add at least one action.</p>}
        {actions.map((a, i) => <ActionRow key={i} module={module} action={a} calcs={calcs} workflows={workflows} disabled={disabled} onChange={(n) => setActions(actions.map((x, j) => (j === i ? n : x)))} onRemove={() => setActions(actions.filter((_, j) => j !== i))} />)}
        <button type="button" disabled={disabled} onClick={() => setActions([...actions, statusFieldOf(module) ? { type: 'set_status', value: statusFieldOf(module)!.options?.[0]?.label ?? '' } : { type: 'update_field', field: writable(module)[0]?.id ?? '', value: '' }])} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-link hover:bg-subtle disabled:opacity-40"><Plus size={12} /> Add action</button>
      </div>
    </section>
  )
}

/** The guided form for a conditional rule: any number of rules, each with nested AND/OR conditions and several actions. */
export function RuleForm({ module, body, calcs, workflows, onChange, disabled }: { module: Module; body: ConditionalRuleBody; calcs: Calculation[]; workflows: Pick<Workflow, 'id' | 'name'>[]; onChange: (b: ConditionalRuleBody) => void; disabled?: boolean }) {
  const set = (patch: Partial<ConditionalRuleBody>) => onChange({ ...body, ...patch })
  const setRule = (i: number, r: RuleItem) => set({ rules: body.rules.map((x, j) => (j === i ? r : x)) })
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <FormField label="Name" required><Input disabled={disabled} value={body.name} onChange={(e) => set({ name: e.target.value })} /></FormField>
        <FormField label="Runs">
          <Select aria-label="Trigger" disabled={disabled} value={body.trigger ?? 'on_record_change'} onChange={(e) => set({ trigger: e.target.value as ConditionalRuleBody['trigger'] })}>
            {RULE_TRIGGERS.map((t) => <option key={t} value={t}>{{ on_record_change: 'When a record changes', on_create: 'When a record is created', schedule: 'On a schedule', manual: 'Only when I ask' }[t]}</option>)}
          </Select>
        </FormField>
        <FormField label="When several rules match">
          <Select aria-label="Mode" disabled={disabled} value={body.mode ?? 'first_match'} onChange={(e) => set({ mode: e.target.value as 'first_match' | 'all' })}>
            <option value="first_match">First match wins</option>
            <option value="all">Run every match</option>
          </Select>
        </FormField>
      </div>
      {body.rules.map((r, i) => (
        <RuleCard key={i} module={module} rule={r} index={i} calcs={calcs} workflows={workflows} disabled={disabled} onChange={(n) => setRule(i, n)} onRemove={body.rules.length > 1 ? () => set({ rules: body.rules.filter((_, j) => j !== i) }) : undefined} />
      ))}
      <div className="flex items-center justify-between">
        <button type="button" disabled={disabled} onClick={() => set({ rules: [...body.rules, { name: `Rule ${body.rules.length + 1}`, logic: 'AND', conditions: [], actions: [] }] })} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-link hover:bg-subtle disabled:opacity-40"><Plus size={12} /> Add rule</button>
        <Switch disabled={disabled} checked={body.enabled !== false} onChange={(v) => set({ enabled: v })} label="Enabled" />
      </div>
    </div>
  )
}
