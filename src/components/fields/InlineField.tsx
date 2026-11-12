import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, Check, Lock } from 'lucide-react'
import type { CrmRecord, Field, Module } from '#/types'
import { usePerms } from '#/hooks/useData'
import { useRecordStore } from '#/stores/recordStore'
import { valueOf, type Ctx } from '#/utils/records'
import { cn } from '#/utils/id'
import { confirmDialog, toast } from '#/utils/toast'
import { Spinner, Segmented } from '#/components/ui/misc'
import { Select, Switch } from '#/components/ui/controls'
import { FieldInput } from './FieldInput'
import { FieldValue } from './FieldValue'
import { commitInline, controlFor, editableState, parseInlineValue, toggleValues, type CommitDeps, type Surface } from './inlineEdit'

export { controlFor } from './inlineEdit'
export type { Control, Surface } from './inlineEdit'

/** the real dependencies: the validated record store write (so recalculation and rules run), the app's confirm dialog and toasts */
const liveDeps: CommitDeps = {
  write: (id, patch) => useRecordStore.getState().update(id, patch, { validate: true }),
  confirm: confirmDialog,
  onError: (title, message) => toast.error(title, message),
}

type Status = 'idle' | 'saving' | 'saved' | 'error'

/**
 * Optimistic save of one field: `shown` is the new value straight away; when the write is refused or throws, `shown` falls back
 * to the stored value (the rollback) and the status turns to 'error'. The toast comes from commitInline.
 */
function useInlineSave(recordId: string, field: Field, stored: unknown, deps: CommitDeps = liveDeps) {
  const [pending, setPending] = useState<{ value: unknown } | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [message, setMessage] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  const settle = (s: Status) => {
    setStatus(s)
    if (timer.current) clearTimeout(timer.current)
    if (s === 'saved' || s === 'error') timer.current = setTimeout(() => setStatus('idle'), s === 'saved' ? 1200 : 3000)
  }
  const save = async (next: unknown) => {
    setPending({ value: next })
    settle('saving')
    const res = await commitInline({ recordId, field, prev: stored, next, deps })
    setPending(null)
    if (res.status === 'saved') settle('saved')
    else if (res.status === 'error') { setMessage(res.message); settle('error') } else settle('idle')
    return res
  }
  return { shown: pending ? pending.value : stored, status, message, save, busy: status === 'saving' }
}

function StatusMark({ status, message }: { status: Status; message: string }) {
  if (status === 'idle') return <span className="size-4 shrink-0" aria-hidden />
  return (
    <span className="inline-flex size-4 shrink-0 items-center justify-center" role="status" aria-live="polite">
      {status === 'saving' && <Spinner size={12} />}
      {status === 'saved' && <Check size={13} className="text-success" aria-label="Saved" />}
      {status === 'error' && <AlertTriangle size={13} className="text-danger" aria-label={`Not saved: ${message}`} />}
    </span>
  )
}

/** keeps clicks inside a control from opening the row / dragging the card */
const stop = (e: { stopPropagation: () => void }) => e.stopPropagation()

interface Props {
  module: Module
  record: CrmRecord
  field: Field
  ctx: Ctx
  surface?: Surface
  /** test seam: replaces the live record store / dialogs */
  deps?: CommitDeps
}

/**
 * One field of one record, editable in place. Toggles for yes/no and two-state choices, a dropdown (or segmented control in the
 * drawer) for longer lists, a date picker, an inline number box that saves on blur or Enter. Read-only (with the reason as a
 * tooltip) when the role cannot edit, or the value is calculated / a formula / an auto id.
 */
export function InlineField(props: Props) {
  const { module, record, field, ctx, surface = 'table' } = props
  // fields without an inline control (text, email, relationships...) stay plain values: no permission lookup per cell
  if (controlFor(field, surface) === 'text') return <FieldValue field={field} value={valueOf(module, record, field, ctx)} ctx={ctx} compact={surface !== 'drawer'} />
  return <Guarded {...props} />
}

function Guarded({ module, record, field, ctx, surface = 'table', deps }: Props) {
  const perms = usePerms()
  const stored = record.data[field.id]
  const control = controlFor(field, surface)
  const state = editableState(field, { canEditModule: perms.canModule(module, 'edit'), access: perms.fieldAccess(field), trashed: !!record.deletedAt })
  const display = <FieldValue field={field} value={valueOf(module, record, field, ctx)} ctx={ctx} compact={surface !== 'drawer'} />
  if (control === 'readonly' || !state.editable) {
    const reason = state.editable ? 'Calculated automatically' : state.reason
    return (
      <span className="inline-flex max-w-full items-center gap-1.5" title={reason} data-readonly="true">
        <span className="min-w-0 truncate">{display}</span>
        {surface === 'drawer' && <Lock size={11} className="shrink-0 text-muted-2" aria-label={reason} />}
      </span>
    )
  }
  return <Editable module={module} record={record} field={field} stored={stored} control={control} surface={surface} deps={deps} />
}

function Editable({ record, field, stored, control, surface, deps }: { module: Module; record: CrmRecord; field: Field; stored: unknown; control: ReturnType<typeof controlFor>; surface: Surface; deps?: CommitDeps }) {
  const { shown, status, message, save, busy } = useInlineSave(record.id, field, stored, deps)
  const wrap = (child: ReactNode) => (
    <div className="inline-flex max-w-full items-center gap-1.5" onClick={stop} onPointerDown={stop} data-status={status}>
      {child}
      <StatusMark status={status} message={message} />
    </div>
  )

  if (control === 'toggle') {
    const t = toggleValues(field)
    const on = field.type === 'yesNo' ? !!shown : shown === t.on
    return wrap(
      <>
        <Switch checked={on} disabled={busy} label={`${field.label}: ${on ? t.onLabel : t.offLabel}`} onChange={(v) => void save(v ? t.on : t.off)} />
        {field.type !== 'yesNo' && <span className="truncate text-xs text-muted">{on ? t.onLabel : t.offLabel}</span>}
      </>,
    )
  }
  if (control === 'segmented') {
    return wrap(
      <Segmented options={(field.options ?? []).map((o) => ({ id: o.id, label: o.label }))} value={String(shown ?? '')} onChange={(v) => void save(v)} />,
    )
  }
  if (control === 'select') {
    return wrap(
      <Select aria-label={field.label} disabled={busy} value={String(shown ?? '')} onChange={(e) => void save(e.target.value)} className={cn('h-7 py-0 text-xs', surface === 'drawer' && 'h-9 text-[13.5px]')}>
        {!field.required && <option value="">—</option>}
        {(field.options ?? []).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </Select>,
    )
  }
  if (control === 'date') {
    return wrap(<FieldInput field={{ ...field, readOnly: false, required: false }} value={shown} disabled={busy} onChange={(v) => void save(v)} />)
  }
  return wrap(<NumberBox field={field} shown={shown} busy={busy} onCommit={(v) => save(v)} />)
}

/** Commits on blur or Enter, Escape puts the old value back. An unreadable number is refused with a message and not saved. */
function NumberBox({ field, shown, busy, onCommit }: { field: Field; shown: unknown; busy: boolean; onCommit: (v: number | '') => Promise<unknown> }) {
  const text = shown === null || shown === undefined ? '' : String(shown)
  const [draft, setDraft] = useState(text)
  const [bad, setBad] = useState('')
  const editing = useRef(false)
  const cancelled = useRef(false)
  useEffect(() => { if (!editing.current) setDraft(text) }, [text])
  const commit = () => {
    editing.current = false
    if (cancelled.current) { cancelled.current = false; return }
    if (draft.trim() === text.trim()) { setBad(''); return }
    const p = parseInlineValue(field, draft)
    if (!p.ok) { setBad(p.error); toast.error(`Could not save ${field.label}`, p.error); setDraft(text); return }
    setBad('')
    void onCommit(p.value)
  }
  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={field.label}
      aria-invalid={bad ? true : undefined}
      title={bad || undefined}
      disabled={busy}
      value={draft}
      placeholder="—"
      onFocus={() => { editing.current = true }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur() }
        else if (e.key === 'Escape') { e.preventDefault(); cancelled.current = true; setDraft(text); setBad(''); (e.target as HTMLInputElement).blur() }
      }}
      className={cn('h-7 w-full min-w-0 rounded-md border border-transparent bg-transparent px-1.5 text-right text-[13px] tabular-nums transition hover:border-line focus:border-primary focus:bg-app focus:outline-none disabled:opacity-60', bad && 'border-danger')}
    />
  )
}
