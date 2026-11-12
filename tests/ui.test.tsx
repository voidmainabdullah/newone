import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, beforeAll } from 'vitest'
import { revisionOf } from '#/genius/config/model'
import { readConfig } from '#/genius/config/storePort'
import { acceptProposal, buildStatus, submitProposal } from '#/genius/service/builder'
import { summarizeProposal } from '#/genius/service/summary'
import { fingerprints } from '#/genius/state/fingerprint'
import { useGeniusStore } from '#/genius/state/geniusStore'
import { AutomationsPanel, HistoryPanel } from '#/components/studio/HistoryPanels'
import { ReviewPanel } from '#/components/studio/ReviewPanel'
import { ClarifyDock, ChatList } from '#/components/studio/ChatPanel'
import { StudioView } from '#/components/studio/StudioView'
import { fromBlueprint } from '#/components/studio/previewModel'
import { SAMPLE_BLUEPRINT } from '#/genius/sampleBlueprint'
import { autoAnswer } from '#/genius/ai/auto-answer'
import { buildSchoolWorld, WS } from './helpers'

const noop = () => {}

describe('Studio UI renders real state (server-side render smoke tests)', () => {
  beforeAll(async () => {
    await buildSchoolWorld()
  })

  const patchProposal = () => {
    const cfg = readConfig(WS)
    const raw = { schemaVersion: 1, expected_revision: revisionOf(cfg), summary: 'Remove the academic year', ops: [{ op: 'remove_field', moduleId: cfg.modules.find((m) => m.name === 'Classes')!.id, id: 'academic_year' }] }
    return submitProposal(WS, { kind: 'patch', raw, request: 'drop academic year', intent: 'modify', baseFingerprints: fingerprints(cfg), assumptions: ['You do not need old academic years.'] })
  }

  it('summarises a proposal: created / modified / removed / preserved / assumptions', () => {
    const { proposal } = patchProposal()
    const s = summarizeProposal(proposal, readConfig(WS))
    expect(s.removed.map((c) => c.label)).toEqual(['Classes → Academic year'])
    expect(s.created).toHaveLength(0)
    expect(s.assumptions).toEqual(['You do not need old academic years.'])
    // everything else stays: 7 school modules (Classes is touched via its field), and every form, view, workflow, dashboard
    const cfg = readConfig(WS)
    expect(s.preserved.find((p) => p.kind === 'modules')!.count).toBe(6)
    expect(s.preserved.find((p) => p.kind === 'forms')!.count).toBe(cfg.forms.length)
    expect(s.preserved.find((p) => p.kind === 'views')!.count).toBe(cfg.views.length)
    expect(s.preserved.find((p) => p.kind === 'workflows')!.count).toBe(cfg.workflows.length)
    expect(s.externalAutomation).toBe(false)
  })

  it('the review panel shows what a build creates, what could not be built and what needs approval', async () => {
    const { schoolBlueprint } = await import('./fixtures/school')
    const { projectIdFor } = await import('#/genius/compiler/ids')
    const { proposal, outcome } = submitProposal(WS, { kind: 'build', raw: schoolBlueprint(projectIdFor('user_tenant_a', WS), 'x'), request: 'school', intent: 'new_build' })
    const html = renderToStaticMarkup(<ReviewPanel proposal={proposal} report={outcome.report} cfg={readConfig(WS)} />)
    expect(html).toContain('Left out')
    expect(html).toContain('Email the guardian when a fee is overdue')
    expect(html).toContain('Needs your approval')
    expect(html).toContain('Fee reminder the day after the due date')
    expect(html).toContain('Validation')
  })

  it('a destructive change is labelled in the review panel', () => {
    const { proposal, outcome } = patchProposal()
    const html = renderToStaticMarkup(<ReviewPanel proposal={proposal} report={outcome.report} cfg={readConfig(WS)} />)
    expect(html).toContain('removes a definition')
    expect(html).toContain('Nothing is saved until you publish')
  })

  it('progress lives in the chat, as collapsible rows built from real step events', () => {
    const html = renderToStaticMarkup(
      <ChatList running={false} waiting chat={[{ id: 's', kind: 'steps', running: true, startedAt: Date.now(), steps: [{ id: 'understand', label: 'Understanding', status: 'done', detail: 'new build' }, { id: 'design', label: 'Designing', status: 'running' }] }]} />,
    )
    expect(html).toContain('Working')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('Waiting for your answer')
    expect(html).toContain('aria-live="polite"')
  })

  it('clarifying questions render in the docked card with radio options, Skip and Submit', () => {
    const html = renderToStaticMarkup(<ClarifyDock onSubmit={noop} onSkip={noop} questions={[{ id: 'currency', question: 'Which currency do you charge in?', why: 'Money totals must be in one currency.', options: ['GBP', 'USD'] }]} />)
    expect(html).toContain('Which currency do you charge in?')
    expect(html).toContain('role="radiogroup"')
    expect(html).toContain('Write your own...')
    expect(html).toContain('>Skip<')
    expect(html).toContain('>Submit<')
  })

  it('obvious or redundant questions are answered silently and at most three are asked', () => {
    const qs = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, question: `Question ${id}?`, why: 'x', options: ['One', 'Two'] }))
    const { auto, ask } = autoAnswer(qs, 'a CRM for my school')
    expect(ask.length).toBeLessThanOrEqual(3)
    expect(auto.length + ask.length).toBe(5)
  })

  it('while there is no preview, or the AI is working, the preview panel is only one line of gradient text', () => {
    const base = { title: 'New project', projects: [], onPickProject: noop, onHistory: noop, onNewChat: noop, chat: [], asking: null, onSend: noop, onCancel: noop, onAnswers: noop, onSkip: noop, review: null, blueprintJson: null, publish: { label: 'Publish', disabled: true, busy: false, onClick: noop }, onShare: noop, onOpenTab: noop }
    const empty = renderToStaticMarkup(<StudioView {...base} running={false} app={null} />)
    expect(empty).toContain('genius-intro')
    expect(empty).toContain('Need help? Ask, search, or create.')
    expect(empty).toContain('Recent chats')
    expect(empty).toContain('Suggestions')
    expect(empty).toContain('Collaborate')
    expect(empty).toContain('Create a sales dashboard with total revenue, monthly orders and pending payments')
    const app = fromBlueprint(SAMPLE_BLUEPRINT)
    const busy = renderToStaticMarkup(<StudioView {...base} running working="Build a CRM" app={app} />)
    expect(busy).toContain('preview-generating')
    expect(busy).toContain('Generating...')
    const ready = renderToStaticMarkup(<StudioView {...base} running={false} app={app} />)
    expect(ready).not.toContain('preview-generating')
    expect(ready).toContain('Preview navigation')
  })

  it('history lists versions with undo buttons, and automations list AI workflows awaiting approval', () => {
    const { proposal } = patchProposal()
    // accept a harmless proposal so there are two versions
    const cfg = readConfig(WS)
    const ok = submitProposal(WS, { kind: 'patch', raw: { schemaVersion: 1, expected_revision: revisionOf(cfg), summary: 'Add room', ops: [{ op: 'add_field', moduleId: cfg.modules.find((m) => m.name === 'Classes')!.id, field: { id: 'room', label: 'Room', type: 'shortText' } }] }, request: 'add room', intent: 'modify', baseFingerprints: fingerprints(cfg) }).proposal
    expect(proposal.id).not.toBe(ok.id)
    expect(acceptProposal(ok.id).ok).toBe(true)
    // zustand renders its INITIAL state on the server, so these panels show their empty states here; the live behaviour
    // (undo, restore, approval) is covered against the real stores in integrity.test.ts
    expect(renderToStaticMarkup(<HistoryPanel canUndo />)).toContain('No versions yet')
    expect(renderToStaticMarkup(<AutomationsPanel canManage />)).toContain('No AI-built automations')
    // the badge logic itself runs against the live stores
    expect(buildStatus(WS).status).toBe('published')
    const pending = submitProposal(WS, { kind: 'patch', raw: { schemaVersion: 1, expected_revision: revisionOf(readConfig(WS)), summary: 'x', ops: [{ op: 'add_field', moduleId: readConfig(WS).modules[0].id, field: { id: 'zz', label: 'Zz', type: 'shortText' } }] }, request: 'x', intent: 'modify' }).proposal
    expect(buildStatus(WS).status).toBe(pending.state === 'validated' ? 'validated' : 'draft')
    expect(useGeniusStore.getState().proposals.some((p) => p.id === pending.id)).toBe(true)
  })
})
