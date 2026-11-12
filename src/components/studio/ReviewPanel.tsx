import type { ConfigModel } from '#/genius/config/model'
import type { RepairDiagnostics } from '#/genius/service/run'
import { kindLabel, summarizeProposal } from '#/genius/service/summary'
import type { Proposal } from '#/genius/state/types'
import type { Issue, ValidationReport } from '#/genius/validation/issues'
import { Badge } from '#/components/ui/misc'
import { cn } from '#/utils/id'

const OP_SYMBOL: Record<string, string> = { add: '+', update: '~', remove: '−', archive: '−', enable: '▶', disable: '■' }

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="section-label">{title}</h3>
      {children}
    </section>
  )
}

function IssueList({ issues }: { issues: Issue[]; danger?: boolean }) {
  if (!issues.length) return null
  return (
    <ul className="space-y-2">
      {issues.map((i, n) => (
        <li key={`${i.code}-${i.path}-${n}`} className="rounded-lg border border-line bg-surface px-3 py-2 text-[13px]">
          <p>{i.message}</p>
          {i.repair && <p className="mt-0.5 text-xs text-muted">Fix: {i.repair}</p>}
        </li>
      ))}
    </ul>
  )
}

/** Everything about a proposal that is not the result itself: what changes, the checks it passed, what was assumed. Shown in the preview's Review tab, never in the chat. */
export function ReviewPanel({ proposal, report, cfg }: { proposal: Proposal; report?: ValidationReport; cfg: ConfigModel; diagnostics?: RepairDiagnostics }) {
  const s = summarizeProposal(proposal, cfg)
  const state = { draft: 'Draft with problems', validated: 'Ready to publish', accepted: 'Published', rejected: 'Rejected', failed: 'Failed', superseded: 'Superseded' }[proposal.state]
  return (
    <div className="space-y-6 p-5 text-[13px]">
      <div>
        <div className="flex flex-wrap items-center gap-2"><h2 className="text-[15px] font-medium">{proposal.summary || 'Proposed change'}</h2><Badge color={proposal.state === 'validated' || proposal.state === 'accepted' ? '#34a853' : undefined}>{state}</Badge></div>
        <p className="mt-1 text-xs text-muted">Nothing is saved until you publish. Your records are never touched by a configuration change.</p>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[['Created', s.created.length], ['Modified', s.modified.length], ['Removed', s.removed.length], ['Not possible', s.notImplementable.length]].map(([l, n]) => (
          <div key={l as string} className="rounded-lg border border-line bg-surface px-3 py-2"><div className="text-lg font-medium tabular-nums">{n}</div><div className="text-xs text-muted">{l}</div></div>
        ))}
      </div>

      {s.notImplementable.length > 0 && (
        <Section title="Left out">
          <ul className="list-disc space-y-1 pl-4 text-muted">{s.notImplementable.map((i) => <li key={`${i.code}${i.path}`}>{i.message}{i.repair ? ` ${i.repair}` : ''}</li>)}</ul>
        </Section>
      )}
      {s.needsApproval.length > 0 && (
        <Section title="Needs your approval">
          <p className="text-muted">These automations are created switched off. Review each dry run under Workflows, then approve.</p>
          <ul className="list-disc space-y-1 pl-4">{s.needsApproval.map((w) => <li key={w.workflowId}>{w.name}: <span className="text-muted">{w.reasons.join('; ')}</span></li>)}</ul>
        </Section>
      )}
      {s.assumptions.length > 0 && (
        <Section title="Assumptions">
          <ul className="list-disc space-y-1 pl-4">{s.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
        </Section>
      )}

      <Section title={`Changes (${proposal.changes.length})`}>
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface" aria-label="Changes">
          {proposal.changes.length === 0 && <li className="px-3 py-2 text-muted">No component would change.</li>}
          {proposal.changes.map((c, i) => (
            <li key={`${c.kind}-${c.id}-${i}`} className="flex items-start gap-3 px-3 py-2">
              <span aria-hidden className={cn('mt-0.5 w-4 shrink-0 text-center', c.op === 'add' ? 'text-success' : c.op === 'remove' || c.op === 'archive' ? 'text-danger' : 'text-muted')}>{OP_SYMBOL[c.op] ?? '~'}</span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5"><span className="font-medium">{c.label}</span><Badge>{c.op} {kindLabel(c.kind)}</Badge>{c.destructive && <Badge color="#ea4335">removes a definition</Badge>}</div>
                {c.details?.length ? <ul className="mt-0.5 text-xs text-muted">{c.details.slice(0, 6).map((d) => <li key={d}>{d}</li>)}</ul> : null}
              </div>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Validation">
        {report ? (
          <>
            <div className="flex flex-wrap items-center gap-2"><Badge color={report.ok ? '#34a853' : '#ea4335'}>{report.ok ? 'All checks passed' : `${report.errors.length} problem${report.errors.length === 1 ? '' : 's'}`}</Badge></div>
            <IssueList issues={report.errors} danger />
            <IssueList issues={report.warnings} />
            {report.sandbox?.ran && <p className="text-xs text-muted">{report.sandbox.syntheticRecords} synthetic records were generated and discarded to test the rules.</p>}
          </>
        ) : proposal.issues.length ? <IssueList issues={proposal.issues} danger /> : <p className="text-muted">All checks passed.</p>}
      </Section>

    </div>
  )
}
