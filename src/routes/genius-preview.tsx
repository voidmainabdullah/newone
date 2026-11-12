import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { StudioView } from '#/components/studio/StudioView'
import { fromBlueprint } from '#/components/studio/previewModel'
import { Icon } from '#/components/ui/Icon'
import { SAMPLE_BLUEPRINT } from '#/genius/sampleBlueprint'
import type { ChatItem } from '#/stores/studioStore'

/** Public, read-only demo of the Studio layout with a hand-written sample CRM. No sign-in, no model call, nothing is saved. */
export const Route = createFileRoute('/genius-preview')({
  head: () => ({ meta: [{ title: 'Studio sample · Blitcrm' }] }),
  component: Demo,
})

const app = fromBlueprint(SAMPLE_BLUEPRINT)

const CHAT: ChatItem[] = [
  { id: '1', kind: 'user', text: 'Create a CRM for my hostel: rooms, guests, bookings and payments' },
  {
    id: '2',
    kind: 'steps',
    running: false,
    startedAt: 0,
    ms: 9000,
    steps: [
      { id: 'understand', label: 'Reading request', status: 'done', detail: 'new build' },
      { id: 'context', label: 'Organizing modules', status: 'done' },
      { id: 'design', label: 'Designing fields', status: 'done' },
      { id: 'validate', label: 'Validating', status: 'done', detail: 'all checks passed' },
    ],
  },
  { id: '3', kind: 'qa', title: "Confirmed the CRM's scope and defaults", pairs: [{ q: 'Which currency should payments use?', a: 'GBP', auto: true }, { q: 'Should bookings follow a pipeline?', a: 'Yes, from enquiry to checked out', auto: true }] },
  { id: '4', kind: 'assistant', text: 'A five-module hostel CRM with a booking pipeline and a dashboard.' },
  { id: '5', kind: 'assistant', tone: 'muted', text: 'The preview on the right shows the result with sample data. Press Publish to create it as its own project.' },
]

const EXPLORE = [['Overview', 'LayoutDashboard'], ['Studio', 'Sparkles'], ['My projects', 'FolderKanban'], ['History', 'History']]
const TOOLS = ['Search', 'Dashboards', 'Reports', 'Forms', 'Workflows', 'Templates']

function Demo() {
  const [chat, setChat] = useState(CHAT)
  return (
    <div className="flex h-screen bg-app">
      <aside className="hidden w-[248px] shrink-0 flex-col border-r border-line bg-side lg:flex">
        <div className="flex h-12 items-center gap-2.5 px-4"><span className="flex size-7 items-center justify-center rounded-lg bg-primary text-[13px] font-semibold text-white">S</span><span className="text-[15px] font-medium">Blitcrm</span></div>
        <div className="space-y-4 px-2.5 pt-2">
          <div>
            <div className="section-label px-2.5 pb-1.5">Explore</div>
            {EXPLORE.map(([l, i]) => <div key={l} className={`flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13px] ${l === 'Studio' ? 'bg-subtle text-fg' : 'text-muted'}`}><Icon name={i} size={16} />{l}</div>)}
          </div>
          <div>
            <div className="section-label px-2.5 pb-1.5">Tools</div>
            {TOOLS.map((l) => <div key={l} className="rounded-lg px-2.5 py-[7px] text-[13px] text-muted">{l}</div>)}
          </div>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <StudioView
          title="New project"
          projects={[]}
          onPickProject={() => {}}
          onHistory={() => {}}
          onNewChat={() => setChat([])}
          chat={chat}
          running={false}
          asking={null}
          onSend={(t) => setChat((c) => [...c, { id: String(c.length + 1), kind: 'user', text: t }, { id: `a${c.length}`, kind: 'assistant', tone: 'muted', text: 'This page is a sample. Sign in to build your own CRM.' }])}
          onCancel={() => {}}
          onAnswers={() => {}}
          onSkip={() => {}}
          app={app}
          review={null}
          publish={{ label: "Publish", disabled: true, busy: false, onClick: () => {} }}
          onShare={() => {}}
          onOpenTab={() => {}}
        />
      </div>
    </div>
  )
}
