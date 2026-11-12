import { formatDistanceToNow } from 'date-fns'
import { useMemo } from 'react'
import { usePageTitle } from '#/hooks/useData'
import { useModuleStore } from '#/stores/moduleStore'
import { useUiStore } from '#/stores/uiStore'
import { useWorkspaceStore } from '#/stores/workspaceStore'
import { isHomeWorkspace } from '#/services/workspaceService'
import { Button } from '#/components/ui/Button'
import { Icon } from '#/components/ui/Icon'
import { EmptyState, PageHeader } from '#/components/ui/misc'
import { useGo } from '#/components/layout/AppLink'

/** Every AI-built or template CRM is its own project. This is the list, with one clear way to open each. */
export function ProjectsPage() {
  const all = useWorkspaceStore((s) => s.workspaces)
  const currentId = useWorkspaceStore((s) => s.currentId)
  const modules = useModuleStore((s) => s.modules)
  const go = useGo()
  usePageTitle('My projects · Blitcrm')
  const projects = useMemo(
    () =>
      all
        .filter((w) => !isHomeWorkspace(w, all))
        .map((w) => ({ w, count: modules.filter((m) => m.workspaceId === w.id && !m.archived && !m.system).length }))
        .sort((a, b) => b.w.updatedAt.localeCompare(a.w.updatedAt)),
    [all, modules],
  )
  const open = (id: string) => {
    useWorkspaceStore.getState().setCurrent(id)
    go('/genius')
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title="My projects" description="Each project is a separate CRM with its own modules, records and sidebar." actions={<Button variant="primary" icon="Plus" onClick={() => useUiStore.getState().setNewProjectOpen(true)}>New project</Button>} />
      {projects.length === 0 ? (
        <EmptyState
          icon="FolderKanban"
          title="No projects yet"
          description="Describe a CRM in Studio and publish it, or start from a template. It appears here."
          action={<div className="flex gap-2"><Button variant="primary" icon="Sparkles" onClick={() => go('/genius')}>Open Studio</Button><Button onClick={() => useUiStore.getState().setNewProjectOpen(true)}>New project</Button></div>}
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-surface">
          <div className="section-label hidden grid-cols-[minmax(0,1fr)_100px_140px_90px] gap-3 border-b border-line px-4 py-2.5 sm:grid"><span>Name</span><span>Modules</span><span>Updated</span><span /></div>
          <ul className="divide-y divide-line">
            {projects.map(({ w, count }) => (
              <li key={w.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_100px_140px_90px]">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-line text-muted"><Icon name={w.icon} size={16} /></span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2"><span className="truncate text-[13px] font-medium">{w.name}</span>{w.id === currentId && <span className="rounded-md border border-line px-1.5 py-px text-[10px] text-muted">Open</span>}</div>
                    <div className="truncate text-xs text-muted sm:hidden">{count} module{count === 1 ? '' : 's'} · {formatDistanceToNow(new Date(w.updatedAt), { addSuffix: true })}</div>
                    {w.description && <div className="hidden truncate text-xs text-muted sm:block">{w.description}</div>}
                  </div>
                </div>
                <span className="hidden text-[13px] text-muted tabular-nums sm:block">{count}</span>
                <span className="hidden text-[13px] text-muted sm:block">{formatDistanceToNow(new Date(w.updatedAt), { addSuffix: true })}</span>
                <Button size="sm" onClick={() => open(w.id)}>Open</Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
