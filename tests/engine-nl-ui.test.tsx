import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { runGenius, type RunOutput } from '#/genius/service/run'
import type { ConfigDraft } from '#/genius/service/configure'
import { ConfigCard } from '#/components/studio/ConfigCard'
import { ChatList } from '#/components/studio/ChatPanel'
import { describeConfig } from '#/engine/describe'
import { useRecordStore } from '#/stores/recordStore'
import { useModuleStore } from '#/stores/moduleStore'
import { putModules } from './engine-fixtures'
import { resetWorld, WS } from './helpers'
import { schoolModules, schoolRecords } from './engine-nl-fixtures'

const noop = () => {}
const offline = async () => ({ ok: false as const, code: 'unavailable' as const, message: 'offline', retryable: true })
const draftFor = async (request: string): Promise<ConfigDraft> => {
  const out: RunOutput = await runGenius({ workspaceId: WS, request }, { transport: offline })
  if (out.kind !== 'configure') throw new Error(`expected a draft, got ${out.kind}`)
  return out.draft
}
const modules = () => useModuleStore.getState().modules
const card = (draft: ConfigDraft, busy = false) => renderToStaticMarkup(<ConfigCard draft={draft} modules={modules()} onConfirm={noop} onEdit={noop} onCancel={noop} busy={busy} />)

beforeEach(() => {
  resetWorld()
  putModules(...schoolModules())
  useRecordStore.getState().setAll(schoolRecords())
})

describe('the Studio configuration card', () => {
  it('a calculation reads as plain words, with a before -> after sample and Confirm / Edit / Cancel', async () => {
    const d = await draftFor('Automatically calculate remaining amount by subtracting paid amount from total amount')
    const html = card(d)
    expect(html).toContain('data-testid="config-card"')
    expect(html).toContain('What it will do')
    expect(html).toContain('Remaining amount')
    expect(html).toContain('paid amount')
    expect(html).toContain('data-testid="config-preview"')
    expect(html).toContain('Before')
    expect(html).toContain('Nothing has been written')
    expect(html).toContain('Draft')
    expect(html).toContain('>Confirm<')
    expect(html).toContain('>Edit<')
    expect(html).toContain('>Cancel<')
    expect(html).not.toContain('data-testid="config-denied"')
    expect(html).not.toMatch(/"type"\s*:/) // no raw JSON in the readable card
  })

  it('a rule card lists each branch, and a dashboard card draws every widget with the real renderer', async () => {
    const rule = await draftFor('If paid amount equals total amount set status to Paid, if paid amount is greater than 0 set status to Partial, otherwise Pending')
    const rhtml = card(rule)
    expect(rhtml).toContain('Paid')
    expect(rhtml).toContain('Partial')
    expect(rhtml).toContain('Pending')
    const dash = await draftFor('create a dashboard showing total students, paid fees, unpaid fees, average attendance and students with attendance below 75%')
    const dhtml = card(dash)
    expect(dhtml).toContain('Widgets')
    expect(dhtml).toContain('Preview with your real records')
    for (const w of (dash.body as { widgets: { id: string }[] }).widgets) expect(dhtml).toContain(`data-widget="${w.id}"`)
  })

  it('without permission the preview still shows, but Confirm and Edit are disabled and the reason is stated', async () => {
    const d = await draftFor('Automatically calculate remaining amount by subtracting paid amount from total amount')
    const denied = { ...d, permission: { allowed: false, message: 'Your role cannot manage fields.' } }
    const html = card(denied)
    expect(html).toContain('data-testid="config-denied"')
    expect(html).toContain('Your role cannot manage fields.')
    expect(html).toContain('data-testid="config-preview"')
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[^<]*(<[^>]*>)*[^<]*Confirm/)
  })

  it('once saved the card says so and drops the buttons', async () => {
    const d = await draftFor('Automatically calculate remaining amount by subtracting paid amount from total amount')
    const html = card({ ...d, status: 'saved', savedId: 'calc_1' })
    expect(html).toContain('Saved')
    expect(html).not.toContain('>Confirm<')
  })

  it('an assistant confirmation carries a link button to the Calculations / Rules tab or the Dashboards page', () => {
    const html = renderToStaticMarkup(<ChatList running={false} waiting={false} onLink={noop} chat={[{ id: 'a1', kind: 'assistant', text: 'Saved.', link: { label: 'Open Calculations', to: '/modules/mod_fees', tab: 'calculations', moduleId: 'mod_fees' } } as never]} />)
    expect(html).toContain('data-testid="chat-link"')
    expect(html).toContain('Open Calculations')
  })
})

describe('describeConfig speaks in the project\'s own names', () => {
  it('names the module and fields instead of ids', async () => {
    const d = await draftFor('Automatically calculate remaining amount by subtracting paid amount from total amount')
    const text = describeConfig(d.body, modules())
    expect(text.title).toBeTruthy()
    const all = [text.title, ...text.lines].join(' ')
    expect(all).not.toMatch(/total_amount|paid_amount|remaining_amount|mod_fees/)
    expect(all.toLowerCase()).toContain('paid amount')
  })
})
