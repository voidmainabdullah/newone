import { useState } from 'react'
import { usePageTitle, usePerms, useWorkspace } from '#/hooks/useData'
import { useGeniusStore } from '#/genius/state/geniusStore'
import { PageHeader, Tabs } from '#/components/ui/misc'
import { AutomationsPanel, HistoryPanel } from '#/components/studio/HistoryPanels'

type Tab = 'versions' | 'automations'

/** Versions of the open project (every applied change can be undone) and the automations Studio designed. */
export function HistoryPage() {
  const perms = usePerms()
  const ws = useWorkspace()
  const count = useGeniusStore((s) => s.versions.filter((v) => v.workspaceId === ws?.id).length)
  const [tab, setTab] = useState<Tab>('versions')
  usePageTitle('History · Blitcrm')
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader title="History" description={ws ? `Changes to ${ws.name}` : undefined} />
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ id: 'versions', label: 'Versions', count }, { id: 'automations', label: 'Automations' }]} />
      {tab === 'versions' ? <HistoryPanel canUndo={perms.can('manageFields')} /> : <AutomationsPanel canManage={perms.can('manageWorkflows')} />}
    </div>
  )
}
