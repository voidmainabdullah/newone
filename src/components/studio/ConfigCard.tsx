import { Check, Info } from 'lucide-react'
import type { Module } from '#/types'
import type { DashboardBody } from '#/engine/schema'
import { describeConfig } from '#/engine/describe'
import type { ConfigDraft } from '#/genius/service/configure'
import { EngineDashboardGrid } from '#/components/dashboard/EngineDashboardGrid'
import { Button } from '#/components/ui/Button'
import { Icon } from '#/components/ui/Icon'
import { cn } from '#/utils/id'

const noop = () => {}
const ICON: Record<ConfigDraft['kind'], string> = { calculations: 'Calculator', conditional_rules: 'Workflow', dashboards: 'PieChart' }

/**
 * The Preview panel for a configuration drafted from words: what it will do (in the project's own names), a sample computed
 * by the engine on up to 5 real records (before -> after), the widgets drawn by the real widget renderer, the assumptions,
 * and Confirm / Edit / Cancel. Nothing here saves anything; the buttons call the Studio store.
 */
export function ConfigCard({ draft, modules, onConfirm, onEdit, onCancel, busy }: { draft: ConfigDraft; modules: Module[]; onConfirm: () => void; onEdit: () => void; onCancel: () => void; busy?: boolean }) {
  const d = describeConfig(draft.body, modules)
  const saved = draft.status === 'saved'
  const rows = draft.preview?.rows ?? []
  const isDash = draft.kind === 'dashboards'
  return (
    <div className="scroll-thin h-full overflow-y-auto p-4 sm:p-6" data-testid="config-card">
      <div className="mx-auto w-full max-w-[760px] space-y-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-subtle"><Icon name={ICON[draft.kind]} size={17} className="text-link" /></span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[15px] font-medium">{d.title}</h2>
              <span className={cn('rounded-full border px-2 py-0.5 text-[11px] font-medium', saved ? 'border-success/40 text-success' : 'border-line text-muted')} data-testid="config-state">{saved ? 'Saved' : 'Draft · not saved yet'}</span>
            </div>
            <p className="mt-1 text-[13px] leading-relaxed text-muted">{draft.summary}</p>
          </div>
        </div>

        <Section title={isDash ? 'Widgets' : 'What it will do'}>
          <ul className="space-y-1.5 text-[13px]" data-testid="config-lines">
            {d.lines.map((l, i) => <li key={i} className="flex gap-2"><span className="mt-[7px] size-1 shrink-0 rounded-full bg-muted-2" /><span className="min-w-0">{l}</span></li>)}
          </ul>
          {d.where && <p className="mt-2.5 text-xs text-muted">{d.where}</p>}
        </Section>

        {isDash ? (
          <Section title="Preview with your real records">
            <EngineDashboardGrid ws={draft.workspaceId} widgets={(draft.body as DashboardBody).widgets} editing={false} onChange={noop} onConfigure={noop} />
          </Section>
        ) : (
          <Section title="Sample result on your records">
            {draft.preview && !draft.preview.ok ? (
              <p className="text-[13px] text-danger">{draft.preview.error ?? 'The preview could not be computed.'}</p>
            ) : rows.length ? (
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full min-w-[420px] text-left text-[13px]" data-testid="config-preview">
                  <thead><tr className="border-b border-line"><th className="section-label px-3 py-2 font-medium">Record</th><th className="section-label px-3 py-2 font-medium">Before</th><th className="section-label px-3 py-2 font-medium">After</th></tr></thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={r.recordId ?? i} className="border-b border-line last:border-0">
                        <td className="px-3 py-2 font-medium">{r.title}</td>
                        <td className="px-3 py-2 text-muted">{r.before}</td>
                        <td className="px-3 py-2">{r.after}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-[13px] text-muted">{draft.preview?.note ?? 'There are no records to preview yet.'}</p>
            )}
            {rows.length > 0 && draft.preview?.note && <p className="mt-2 text-xs text-muted">{draft.preview.note}</p>}
            {rows.length > 0 && <p className="mt-2 text-xs text-muted">Calculated on {rows.length === 1 ? '1 real record' : `${rows.length} real records`}. Nothing has been written.</p>}
          </Section>
        )}

        {draft.assumptions.length > 0 && (
          <Section title="Assumed for you">
            <ul className="space-y-1 text-[13px] text-muted" data-testid="config-assumptions">{draft.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
          </Section>
        )}

        {!draft.permission.allowed && (
          <div role="alert" className="flex items-start gap-2 rounded-xl border border-line bg-surface p-3 text-[13px]" data-testid="config-denied">
            <Info size={15} className="mt-0.5 shrink-0 text-muted" />
            <span>{draft.permission.message ?? 'Your role is not allowed to make this change.'} You can read the preview, but only someone with access can confirm it.</span>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 pb-2">
          {saved ? (
            <span className="flex items-center gap-1.5 text-[13px] text-success"><Check size={15} />Saved. Use the link in the chat to open it.</span>
          ) : (
            <>
              <Button variant="primary" size="md" icon="Check" onClick={onConfirm} disabled={busy || !draft.permission.allowed} title={draft.permission.allowed ? 'Save it and run it on your records' : (draft.permission.message ?? 'Not allowed')}>Confirm</Button>
              <Button size="md" icon="Pencil" onClick={onEdit} disabled={busy || !draft.permission.allowed}>Edit</Button>
              <Button size="md" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      <div className="section-label mb-2.5">{title}</div>
      {children}
    </section>
  )
}
