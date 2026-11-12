import { useEffect, useState } from 'react'
import { useAllModules, useDataFlows, useModule, usePerms, useRecords } from '#/hooks/useData'
import { useSettingsStore } from '#/stores/settingsStore'
import { useWsId } from '#/hooks/useData'
import { Page } from '#/components/layout/Page'
import { useGo } from '#/components/layout/AppLink'
import { Button } from '#/components/ui/Button'
import { EmptyState, PageHeader, Tabs } from '#/components/ui/misc'
import { Icon } from '#/components/ui/Icon'
import { RecordsView } from '#/components/records/RecordsView'
import { ConfigList } from '#/components/engine/ConfigList'
import { useEngineStore } from '#/stores/engineStore'
import { useConfigNav } from '#/stores/configNavStore'
import { resolveModule } from '#/engine/resolve'
import { FieldManager } from '#/builders/ModuleBuilder/FieldManager'
import { ModuleSettings } from '#/builders/ModuleBuilder/ModuleSettings'
import { DataFlowWorkspace } from '#/builders/DataFlow/DataFlowWorkspace'
import { ActivityPanel, AttachmentsPanel, FormsPanel, RelationshipsPanel, ViewsPanel } from '#/builders/ModuleBuilder/ModulePanels'
import { useModuleActions } from './ModulesPage'
import { usePageTitle } from '#/hooks/useData'

type Tab = 'records' | 'fields' | 'calculations' | 'rules' | 'forms' | 'views' | 'relationships' | 'dataflow' | 'activity' | 'attachments' | 'settings'

export function ModulePage({ moduleId }: { moduleId: string }) {
  const module = useModule(moduleId)
  const modules = useAllModules()
  const ws = useWsId()
  const perms = usePerms()
  const go = useGo()
  const a = useModuleActions()
  const [tab, setTab] = useState<Tab>('records')
  const recordCount = useRecords(moduleId).length
  const flowCount = useDataFlows(moduleId).length
  const engineDoc = useEngineStore((s) => s.docs.find((d) => d.id === ws))
  const calcCount = (engineDoc?.calculations ?? []).filter((c) => resolveModule(modules, c.entity)?.id === moduleId).length
  const ruleCount = (engineDoc?.conditional_rules ?? []).filter((c) => resolveModule(modules, c.entity)?.id === moduleId).length
  const parent = module?.parentId ? modules.find((m) => m.id === module.parentId) : undefined
  const children = modules.filter((m) => m.parentId === moduleId)
  usePageTitle(module ? `${module.name} · Blitcrm` : 'Module not found · Blitcrm')

  // Studio hands a drafted calculation / rule over here ("Edit"), or links to a tab ("Open Calculations")
  const navModule = useConfigNav((s) => s.module)
  const navTab = useConfigNav((s) => s.tab)
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null)
  useEffect(() => { setTab('records'); setDraft(null) }, [moduleId])
  useEffect(() => {
    if (navModule && navModule.moduleId === moduleId && navModule.workspaceId === ws) {
      setTab(navModule.tab)
      setDraft(navModule.body)
      useConfigNav.getState().clear('module')
    } else if (navTab && navTab.moduleId === moduleId) {
      setTab(navTab.tab)
      useConfigNav.getState().clear('tab')
    }
  }, [moduleId, navModule, navTab]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (module) useSettingsStore.getState().addRecent(ws, { moduleId: module.id, label: module.name }) }, [module?.id, ws]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!module) {
    return (
      <Page title="Module not found">
        <EmptyState icon="SearchX" title="Module not found" description="It may have been deleted or belongs to another workspace." action={<Button variant="primary" onClick={() => go('/modules')}>All modules</Button>} />
      </Page>
    )
  }

  return (
    <Page title={module.name} skeleton="table" loadKey={module.id} wide>
      <PageHeader
        title={module.name}
        icon={module.icon}
        description={[parent && `Submodule of ${parent.name}`, module.description].filter(Boolean).join(' · ') || undefined}
        actions={
          <>
            {flowCount > 0 && <Button size="sm" icon="Network" title="This module is connected to other modules by data flows" onClick={() => setTab('dataflow')}>Flows · {flowCount}</Button>}
            {children.map((c) => <Button key={c.id} size="sm" onClick={() => a.open(c)}><Icon name={c.icon} size={13} /> {c.name}</Button>)}
            {perms.can('manageFields') && <Button size="sm" icon="Wand2" onClick={() => a.edit(module)}>Open in builder</Button>}
          </>
        }
      />
      {module.archived && <div className="mb-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[13px]">This module is archived. <button className="font-medium text-link hover:underline" type="button" onClick={() => a.archive(module)}>Restore it</button></div>}
      <Tabs<Tab> colorful
        className="mb-5"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'records', label: 'Records', icon: 'Table2', count: recordCount },
          { id: 'fields', label: 'Fields', icon: 'Columns3', count: module.fields.length },
          { id: 'calculations', label: 'Calculations', icon: 'Calculator', count: calcCount || undefined },
          { id: 'rules', label: 'Rules', icon: 'Workflow', count: ruleCount || undefined },
          { id: 'forms', label: 'Forms', icon: 'FormInput' },
          { id: 'views', label: 'Views', icon: 'LayoutGrid' },
          { id: 'relationships', label: 'Relationships', icon: 'Link2' },
          { id: 'dataflow', label: 'Data flow', icon: 'Network', count: flowCount || undefined },
          { id: 'activity', label: 'Activity', icon: 'History' },
          { id: 'attachments', label: 'Attachments', icon: 'Paperclip' },
          { id: 'settings', label: 'Settings', icon: 'Settings' },
        ]}
      />
      {tab === 'records' && <RecordsView module={module} />}
      {tab === 'fields' && <FieldManager module={module} />}
      {tab === 'calculations' && <ConfigList module={module} kind="calculations" draft={draft?.type === 'calculation' ? draft : null} onDraftUsed={() => setDraft(null)} />}
      {tab === 'rules' && <ConfigList module={module} kind="conditional_rules" draft={draft?.type === 'conditional_rule' ? draft : null} onDraftUsed={() => setDraft(null)} />}
      {tab === 'forms' && <FormsPanel module={module} />}
      {tab === 'views' && <ViewsPanel module={module} />}
      {tab === 'relationships' && <RelationshipsPanel module={module} />}
      {tab === 'dataflow' && <DataFlowWorkspace focusModuleId={module.id} />}
      {tab === 'activity' && <ActivityPanel module={module} />}
      {tab === 'attachments' && <AttachmentsPanel module={module} />}
      {tab === 'settings' && (
        <div className="max-w-3xl space-y-8">
          <ModuleSettings module={module} />
          {perms.can('manageFields') && (
            <section className="rounded-xl border border-danger/30 p-4">
              <h3 className="text-sm font-semibold text-danger">Danger zone</h3>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button onClick={() => a.duplicate(module)} icon="Copy">Duplicate</Button>
                <Button onClick={() => a.archive(module)} icon={module.archived ? 'RotateCcw' : 'Archive'}>{module.archived ? 'Restore' : 'Archive'}</Button>
                <Button variant="danger" icon="Trash2" onClick={async () => { await a.remove(module) }}>Delete module</Button>
              </div>
            </section>
          )}
        </div>
      )}
    </Page>
  )
}
