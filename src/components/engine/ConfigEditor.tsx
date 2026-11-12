import { useMemo, useState } from 'react'
import type { Module } from '#/types'
import { useAllModules, usePerms, useWorkflows } from '#/hooks/useData'
import { useEngineStore } from '#/stores/engineStore'
import { blankCalculation, blankRule, bodyOfItem, checkJson, previewConfig, toJson, type EditableKind } from '#/engine/editing'
import { saveAndRun } from '#/engine/service'
import type { Calculation, CalculationBody, ConditionalRule, ConditionalRuleBody } from '#/engine/schema'
import { toast } from '#/utils/toast'
import { Button } from '#/components/ui/Button'
import { Modal } from '#/components/ui/Modal'
import { Notice, Tabs } from '#/components/ui/misc'
import { Textarea } from '#/components/ui/controls'
import { CalculationForm } from './CalculationForm'
import { RuleForm } from './RuleForm'

type Mode = 'guided' | 'json'
type Body = CalculationBody | ConditionalRuleBody

/** What is shown under the editor while it is valid: the result on up to 5 real records, nothing is written. */
function PreviewPanel({ ws, text }: { ws: string; text: string }) {
  const preview = useMemo(() => {
    try {
      return previewConfig(ws, JSON.parse(text) as Body, { limit: 5 })
    } catch {
      return null
    }
  }, [ws, text])
  if (!preview) return null
  return (
    <section aria-label="Preview" className="rounded-xl border border-line p-3">
      <h4 className="text-xs font-semibold tracking-wider text-muted uppercase">Preview on up to 5 records</h4>
      {preview.error && <p className="mt-2 text-[13px] text-danger">{preview.error}</p>}
      {preview.note && <p className="mt-2 text-xs text-muted">{preview.note}</p>}
      {preview.rows.length > 0 && (
        <table className="mt-2 w-full text-[13px]">
          <thead><tr className="text-left text-xs text-muted"><th className="py-1 pr-3 font-medium">Record</th><th className="py-1 pr-3 font-medium">Now</th><th className="py-1 font-medium">After saving</th></tr></thead>
          <tbody>{preview.rows.map((r, i) => <tr key={r.recordId ?? i} className="border-t border-line"><td className="max-w-[180px] truncate py-1.5 pr-3">{r.title}</td><td className="py-1.5 pr-3 text-muted">{r.before}</td><td className="py-1.5 font-medium tabular-nums">{r.after}</td></tr>)}</tbody>
        </table>
      )}
      <p className="mt-2 text-[11px] text-muted">Nothing is saved or changed by the preview.</p>
    </section>
  )
}

/**
 * Create or edit a calculation / rule: a guided form and a raw JSON editor over the same configuration. Every keystroke is
 * validated against the real project (validateConfig): the errors name the path, Save stays disabled while there are any,
 * a circular dependency is explained, and the result is previewed on real records. Saving goes through the engine service
 * (validated, versioned, persisted) and then recalculates.
 */
export function ConfigEditor({ ws, module, kind, item, initial, onClose }: { ws: string; module: Module; kind: EditableKind; item?: Calculation | ConditionalRule; /** a draft to start from (for example one drafted in Studio): it is checked like anything typed here */ initial?: Record<string, unknown>; onClose: () => void }) {
  const perms = usePerms()
  const modules = useAllModules()
  const docs = useEngineStore((s) => s.docs)
  const workflows = useWorkflows()
  const [mode, setMode] = useState<Mode>('guided')
  const [body, setBody] = useState<Body>(() => (item ? (bodyOfItem(item) as unknown as Body) : initial ? (initial as unknown as Body) : kind === 'calculations' ? blankCalculation(module) : blankRule(module)))
  const [text, setText] = useState(() => toJson(body))
  const [saving, setSaving] = useState(false)
  const canEdit = perms.can(kind === 'calculations' ? 'manageFields' : 'manageWorkflows')
  const current = mode === 'json' ? text : toJson(body)
  const calcs = useMemo(() => docs.find((d) => d.id === ws)?.calculations ?? [], [docs, ws])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const check = useMemo(() => checkJson(current, ws, { expected: kind, id: item?.id }), [current, ws, kind, item?.id, modules, docs])
  const noun = kind === 'calculations' ? 'calculation' : 'rule'

  const switchTo = (next: Mode) => {
    if (next === mode) return
    if (next === 'json') setText(toJson(body))
    else {
      try {
        const parsed = JSON.parse(text) as Body
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('A configuration must be a JSON object')
        setBody(parsed)
      } catch (e) {
        toast.error('Fix the JSON first', e instanceof Error ? e.message : 'It is not valid JSON')
        return
      }
    }
    setMode(next)
  }

  const save = async () => {
    setSaving(true)
    try {
      const res = await saveAndRun(ws, current, { id: item?.id, expected: kind })
      if (!res.ok) {
        toast.error(`Could not save the ${noun}`, res.errors[0]?.message)
        return
      }
      const extra = res.createdFields.length ? ` Created ${res.createdFields.join(', ')}.` : ''
      toast.success(item ? `${noun[0].toUpperCase()}${noun.slice(1)} updated` : `${noun[0].toUpperCase()}${noun.slice(1)} saved`, res.report ? `Applied to ${res.report.processed} records.${extra}` : extra || undefined)
      for (const w of res.warnings) toast.info('Heads up', w)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} size="xl" title={item ? `Edit ${noun}: ${item.name}` : `New ${noun}`} description={`Runs on ${module.name}. Changes are checked against your real fields before they can be saved.`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!check.ok || !canEdit || saving} onClick={() => void save()}>{saving ? 'Saving…' : item ? 'Save and apply' : 'Save and run'}</Button></>}>
      <div className="space-y-4">
        {!canEdit && <Notice tone="warning">Your role cannot change {kind === 'calculations' ? 'calculations' : 'rules'}. You can look, but not save.</Notice>}
        <Tabs<Mode> value={mode} onChange={switchTo} tabs={[{ id: 'guided', label: 'Guided form', icon: 'Sparkles' }, { id: 'json', label: 'JSON', icon: 'Code' }]} />
        {mode === 'guided' ? (
          kind === 'calculations'
            ? <CalculationForm module={module} body={body as CalculationBody} onChange={setBody} disabled={!canEdit} />
            : <RuleForm module={module} body={body as ConditionalRuleBody} calcs={calcs} workflows={workflows} onChange={setBody} disabled={!canEdit} />
        ) : (
          <div className="space-y-1.5">
            <Textarea aria-label="Configuration JSON" spellCheck={false} disabled={!canEdit} value={text} onChange={(e) => setText(e.target.value)} className="min-h-[300px] font-mono text-[12.5px] leading-relaxed" />
            <p className="text-xs text-muted">The same configuration the guided form edits. Use field ids or API names exactly as they appear in the module.</p>
          </div>
        )}

        <div aria-live="polite" className="space-y-2">
          {check.cycle && <Notice tone="danger" icon="AlertTriangle"><strong>Circular dependency.</strong> {check.errors[0]?.message}</Notice>}
          {!check.ok && !check.cycle && check.errors.length > 0 && (
            <div role="alert" className="rounded-lg border border-danger/30 bg-danger/5 p-3">
              <div className="mb-1 text-[13px] font-semibold text-danger">{check.errors.length} problem{check.errors.length === 1 ? '' : 's'} to fix before saving</div>
              <ul className="space-y-1 text-[13px]">
                {check.errors.slice(0, 12).map((e, i) => <li key={i} className="flex gap-2"><code className="shrink-0 rounded bg-subtle px-1.5 text-[12px] text-muted">{e.path}</code><span>{e.message}</span></li>)}
              </ul>
            </div>
          )}
          {check.ok && <p className="text-[13px] text-success">✓ Valid. Saving creates version {item ? item.version + 1 : 1}.</p>}
        </div>

        {check.ok && <PreviewPanel ws={ws} text={current} />}
      </div>
    </Modal>
  )
}
