import { Check, ChevronsUpDown, CloudCheck, CloudOff, Command as CommandIcon, Menu as MenuIcon, Plus, Search } from 'lucide-react'
import { format } from 'date-fns'
import { useModules, usePerms, useWorkspace } from '#/hooks/useData'
import { useWorkspaceStore } from '#/stores/workspaceStore'
import { useUiStore } from '#/stores/uiStore'
import { useSaveStatus } from '#/stores'
import { isHomeWorkspace } from '#/services/workspaceService'
import { Icon } from '#/components/ui/Icon'
import { Menu, Popover } from '#/components/ui/Popover'
import { cn } from '#/utils/id'
import { useGo } from './AppLink'
import { GeniusStudioButton } from './GeniusStudioButton'

/** Top bar for every page except Studio: sidebar toggle, project switcher, search, quick-create and save status. */
export function Topbar({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const ws = useWorkspace()
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const setCurrent = useWorkspaceStore((s) => s.setCurrent)
  const setCommandOpen = useUiStore((s) => s.setCommandOpen)
  const setNewProject = useUiStore((s) => s.setNewProjectOpen)
  const startNewRecord = useUiStore((s) => s.startNewRecord)
  const modules = useModules()
  const perms = usePerms()
  const save = useSaveStatus()
  const go = useGo()
  const home = workspaces.find((w) => isHomeWorkspace(w, workspaces))
  const projects = workspaces.filter((w) => !isHomeWorkspace(w, workspaces))
  const label = ws && home && ws.id === home.id ? 'Home' : (ws?.name ?? 'Project')

  const row = (w: { id: string; name: string; icon?: string }, name: string, close: () => void) => (
    <button key={w.id} type="button" onClick={() => { setCurrent(w.id); close(); go('/') }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-subtle">
      <Icon name={w.icon} size={14} className="text-muted" />
      <span className="flex-1 truncate">{name}</span>
      {w.id === ws?.id && <Check size={14} className="text-link" />}
    </button>
  )

  return (
    <header className="no-print sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b border-line bg-app px-3 sm:px-4">
      <button type="button" aria-label="Toggle sidebar" onClick={onToggleSidebar} className="rounded-lg p-1.5 text-muted hover:bg-surface hover:text-fg">
        <MenuIcon size={17} />
      </button>

      <Popover
        width={264}
        trigger={({ toggle, ref }) => (
          <button ref={ref} type="button" onClick={toggle} aria-label="Switch project" className="flex max-w-[220px] items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-[13px] font-medium hover:bg-surface">
            <Icon name={ws?.icon} size={14} className="shrink-0 text-muted" />
            <span className="hidden truncate sm:inline">{label}</span>
            <ChevronsUpDown size={13} className="shrink-0 text-muted" />
          </button>
        )}
      >
        {(close) => (
          <div>
            {home && (
              <>
                <div className="section-label px-2.5 py-1.5">Home</div>
                {row(home, 'Home', close)}
              </>
            )}
            <div className="section-label px-2.5 pt-2 pb-1.5">Projects</div>
            {projects.length === 0 && <p className="px-2.5 pb-1.5 text-xs text-muted-2">No projects yet.</p>}
            {projects.map((w) => row(w, w.name, close))}
            <div className="my-1 h-px bg-line" />
            <button type="button" onClick={() => { close(); setNewProject(true) }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-subtle"><Plus size={14} className="text-muted" />New project</button>
            <button type="button" onClick={() => { close(); go('/projects') }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-subtle"><Icon name="FolderKanban" size={14} className="text-muted" />My projects</button>
          </div>
        )}
      </Popover>

      <button type="button" onClick={() => setCommandOpen(true)} className="mx-1 flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-left text-[13px] text-muted transition hover:border-line-strong sm:max-w-md" aria-label="Search">
        <Search size={14} />
        <span className="flex-1 truncate">Search modules, records, pages</span>
        <kbd className="hidden items-center gap-0.5 rounded border border-line px-1.5 py-0.5 text-[10px] sm:flex"><CommandIcon size={10} />K</kbd>
      </button>

      <div className="ml-auto flex items-center gap-1">
        <GeniusStudioButton variant="compact" />
        <span className={cn('hidden items-center gap-1 px-2 text-xs md:flex', save.failed ? 'text-danger' : 'text-muted-2')} aria-live="polite">
          {save.failed ? <CloudOff size={14} /> : <CloudCheck size={14} />}
          {save.failed ? 'Not saved' : save.pending ? 'Saving' : save.savedAt ? `Saved ${format(save.savedAt, 'HH:mm:ss')}` : 'Autosave on'}
        </span>

        <Menu
          width={230}
          items={[
            ...modules.slice(0, 8).map((m) => ({ label: `New ${m.name.replace(/s$/, '').toLowerCase()}`, icon: m.icon, disabled: !perms.canModule(m, 'create'), onClick: () => startNewRecord(m.id) })),
            ...(modules.length ? [{ divider: true }] : []),
            { label: 'Open Genius Studio', icon: 'Sparkles', onClick: () => go('/genius') },
            { label: 'New module', icon: 'Box', disabled: !perms.can('manageFields'), onClick: () => go('/module-builder') },
            { label: 'Install template', icon: 'LayoutTemplate', onClick: () => go('/templates') },
          ]}
          trigger={({ toggle, ref }) => (
            <button ref={ref} type="button" onClick={toggle} className="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[13px] font-medium text-white transition hover:bg-primary-strong">
              <Plus size={15} /> <span className="hidden sm:inline">New</span>
            </button>
          )}
        />
      </div>
    </header>
  )
}
