import { useMemo, useState } from 'react'
import { useAllModules, usePerms, useWsId } from '#/hooks/useData'
import { useEngineStore } from '#/stores/engineStore'
import { useEngineStatus } from '#/engine/status'
import { bodyOfItem, dependencyInfo, summarize, type EditableKind } from '#/engine/editing'
import { recalculateConfig, recalculateModule, type RecalcProgress } from '#/engine/runtime'
import { removeConfig, saveConfig, setConfigEnabled } from '#/engine/service'
import { resolveModule } from '#/engine/resolve'
import type { Calculation, CalculationBody, ConditionalRule, ConditionalRuleBody } from '#/engine/schema'
import type { Module } from '#/types'
import { confirmDialog, toast } from '#/utils/toast'
import { Button } from '#/components/ui/Button'
import { Switch } from '#/components/ui/controls'
import { Badge, EmptyState } from '#/components/ui/misc'
import { Icon } from '#/components/ui/Icon'
import { ConfigEditor } from './ConfigEditor'

type Item = Calculation | ConditionalRule

const COPY: Record<EditableKind, { noun: string; plural: string; icon: string; empty: string }> = {
  calculations: { noun: 'calculation', plural: 'Calculations', icon: 'Calculator', empty: 'Work out totals, balances and percentages automatically: for example remaining = total − paid, kept up to date on every record.' },
  conditional_rules: { noun: 'rule', plural: 'Rules', icon: 'Workflow', empty: 'Set statuses and fields automatically: for example mark a fee Paid, Partial or Pending from how much has been paid.' },
}

function Details({ ws, id }: { ws: string; id: string }) {
  const info = useMemo(() => dependencyInfo(ws, id), [ws, id])
  if (!info) return <p className="text-xs text-muted">Disabled configurations are not part of the dependency graph.</p>
  const line = (label: string, list: string[]) => <div><span className="text-muted">{label}: </span>{list.length ? list.join(', ') : '—'}</div>
  return (
    <div className="space-y-0.5 text-xs">
      {line('Reads', info.reads)}
      {line('Writes', info.writes)}
      {line('Runs after', info.dependsOn)}
      {line('Feeds', info.usedBy)}
      {info.inCycle && <div className="font-medium text-danger">Part of a circular dependency: it will not run until that is fixed.</div>}
    </div>
  )
}

function Row({ ws, kind, item, module, canEdit, onEdit }: { ws: string; kind: EditableKind; item: Item; module: Module; canEdit: boolean; onEdit: () => void }) {
  const status = useEngineStatus((s) => s.status[item.id])
  const [open, setOpen] = useState(false)
  const [progress, setProgress] = useState<RecalcProgress | null>(null)
  const noun = COPY[kind].noun
  const body = bodyOfItem(item) as unknown as CalculationBody | ConditionalRuleBody
  const guard = <T,>(r: { ok: boolean; error?: string } & T) => { if (!r.ok) toast.error('Not allowed', r.error) ; return r.ok }

  const recalc = async () => {
    setProgress({ phase: 'config', module: module.name, done: 0, total: 0, written: 0, errors: 0 })
    try {
      const rep = await recalculateConfig(ws, item.id, { onProgress: setProgress })
      if (rep.errors.length) toast.warning(`Recalculated with ${rep.errors.length} problem${rep.errors.length === 1 ? '' : 's'}`, rep.errors[0].message)
      else toast.success('Recalculated', `${rep.processed} records checked, ${rep.written} updated.`)
    } finally {
      setProgress(null)
    }
  }
  const duplicate = () => {
    const res = saveConfig(ws, { ...body, name: `${body.name} (copy)`, enabled: false })
    if (!res.ok) return void toast.error('Could not duplicate', res.errors[0]?.message)
    toast.success('Duplicated', 'The copy is switched off until you enable it.')
  }
  const del = async () => {
    if (await confirmDialog({ title: `Delete “${item.name}”?`, message: kind === 'calculations' ? 'Values already calculated stay on the records; they just stop updating.' : 'Statuses already set stay as they are; they just stop being set automatically.', confirmLabel: 'Delete', danger: true })) {
      if (guard(removeConfig(ws, kind, item.id))) toast.success(`${noun[0].toUpperCase()}${noun.slice(1)} deleted`)
    }
  }

  return (
    <li className="rounded-xl border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center gap-3">
        <Switch checked={item.enabled} disabled={!canEdit} label={`${item.enabled ? 'Disable' : 'Enable'} ${item.name}`} onChange={(v) => void guard(setConfigEnabled(ws, kind, item.id, v))} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[14px] font-medium">{item.name}</span>
            <Badge>v{item.version}</Badge>
            <Badge>{(body as { trigger?: string }).trigger?.replace(/_/g, ' ') ?? 'on record change'}</Badge>
            {!item.enabled && <Badge color="#9aa0a6">Off</Badge>}
          </div>
          <div className="truncate text-xs text-muted">{summarize(body, module)}</div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {kind === 'calculations' && (
            <Button size="xs" icon="RotateCcw" disabled={!canEdit || !item.enabled || !!progress} onClick={() => void recalc()}>{progress ? (progress.total ? `${progress.done}/${progress.total}` : 'Working…') : 'Recalculate now'}</Button>
          )}
          <Button size="xs" icon="Pencil" onClick={onEdit}>{canEdit ? 'Edit' : 'View'}</Button>
          <Button size="xs" icon="Copy" disabled={!canEdit} onClick={duplicate}>Duplicate</Button>
          <Button size="xs" icon="Trash2" disabled={!canEdit} onClick={() => void del()}>Delete</Button>
          <button type="button" aria-expanded={open} aria-label={open ? 'Hide details' : 'Show details'} onClick={() => setOpen(!open)} className="rounded p-1.5 text-muted hover:bg-subtle"><Icon name="Info" size={14} /></button>
        </div>
      </div>
      {progress && progress.total > 0 && <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-subtle" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} /></div>}
      <div className="mt-2 text-xs" aria-label="Last run">
        {status ? (
          status.ok
            ? <span className="text-success">✓ Last ran {new Date(status.lastRunAt).toLocaleTimeString()} · {status.records} records · {status.writes} fields updated</span>
            : <span className="text-danger">✕ {status.error ?? 'The last run failed'}</span>
        ) : <span className="text-muted">Has not run since the app opened.</span>}
      </div>
      {open && <div className="mt-2 border-t border-line pt-2"><Details ws={ws} id={item.id} /></div>}
    </li>
  )
}

/** The Calculations / Rules tab of a module: every configuration of this module with its status, plus the editor. */
export function ConfigList({ module, kind, draft, onDraftUsed }: { module: Module; kind: EditableKind; /** a configuration drafted elsewhere (Studio's "Edit"): the editor opens on it right away */ draft?: Record<string, unknown> | null; onDraftUsed?: () => void }) {
  const ws = useWsId()
  const perms = usePerms()
  const modules = useAllModules()
  const docs = useEngineStore((s) => s.docs)
  const [editing, setEditing] = useState<Item | 'new' | null>(draft ? 'new' : null)
  const [seed, setSeed] = useState<Record<string, unknown> | undefined>(draft ?? undefined)
  const openNew = () => { setSeed(undefined); setEditing('new') }
  const closeEditor = () => { setEditing(null); setSeed(undefined); onDraftUsed?.() }
  const [bulk, setBulk] = useState<RecalcProgress | null>(null)
  const canEdit = perms.can(kind === 'calculations' ? 'manageFields' : 'manageWorkflows')
  const doc = docs.find((d) => d.id === ws)
  const items = useMemo(() => ((kind === 'calculations' ? doc?.calculations : doc?.conditional_rules) ?? []).filter((c) => resolveModule(modules, c.entity)?.id === module.id) as Item[], [doc, kind, modules, module.id])
  const copy = COPY[kind]

  const recalcAll = async () => {
    setBulk({ phase: 'module', module: module.name, done: 0, total: 0, written: 0, errors: 0 })
    try {
      const rep = await recalculateModule(module.id, { onProgress: setBulk })
      if (rep.errors.length) toast.warning(`Recalculated with ${rep.errors.length} problem${rep.errors.length === 1 ? '' : 's'}`, rep.errors[0].message)
      else toast.success('Recalculated', `${rep.processed} records checked, ${rep.written} updated.`)
    } finally {
      setBulk(null)
    }
  }

  return (
    <div className="max-w-4xl space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-muted">{copy.plural} for {module.name}. They run whenever a record changes{kind === 'calculations' ? ', or when you recalculate' : ''} while the app is open.</p>
        <div className="flex gap-2">
          {kind === 'calculations' && items.length > 0 && <Button size="sm" icon="RotateCcw" disabled={!canEdit || !!bulk} onClick={() => void recalcAll()}>{bulk ? (bulk.total ? `Recalculating ${bulk.done}/${bulk.total}` : 'Working…') : 'Recalculate all'}</Button>}
          <Button size="sm" variant="primary" icon="Plus" disabled={!canEdit} onClick={openNew}>New {copy.noun}</Button>
        </div>
      </div>
      {!canEdit && <p className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[13px]">Your role can view {copy.plural.toLowerCase()} but not change them.</p>}
      {items.length === 0 ? (
        <EmptyState icon={copy.icon} title={`No ${copy.plural.toLowerCase()} yet`} description={copy.empty} action={canEdit && <Button variant="primary" icon="Plus" onClick={openNew}>New {copy.noun}</Button>} />
      ) : (
        <ul className="space-y-2">{items.map((it) => <Row key={it.id} ws={ws} kind={kind} item={it} module={module} canEdit={canEdit} onEdit={() => setEditing(it)} />)}</ul>
      )}
      {editing && <ConfigEditor key={editing === 'new' ? 'new' : editing.id} ws={ws} module={module} kind={kind} item={editing === 'new' ? undefined : editing} initial={editing === 'new' ? seed : undefined} onClose={closeEditor} />}
    </div>
  )
}
