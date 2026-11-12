import type { ReactNode } from 'react'
import { PanelLeftOpen } from 'lucide-react'
import { useModules, useWorkspace } from '#/hooks/useData'
import { useSettingsStore } from '#/stores/settingsStore'
import { useWorkspaceStore } from '#/stores/workspaceStore'
import { isHomeWorkspace } from '#/services/workspaceService'
import { Icon } from '#/components/ui/Icon'
import { cn } from '#/utils/id'
import { AppLink, usePathname } from './AppLink'
import { AccountMenu, inModules, inSettings, inTools, isActive } from './Sidebar'
import { DashboardIcon, ModulesIcon, SettingsIcon, ToolsIcon } from './NavIcons'
import { GeniusStudioButton } from './GeniusStudioButton'
import { ThemeToggle } from './ThemeToggle'

const ICON = 22

function RailItem({ to, label, active, children }: { to: string; label: string; active: boolean; children: ReactNode }) {
  return (
    <AppLink to={to} title={label} className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg transition', active ? 'bg-subtle text-fg' : 'text-muted hover:bg-surface hover:text-fg')}>
      <span className="sr-only">{label}</span>
      {children}
    </AppLink>
  )
}

/** The collapsed sidebar: a narrow icon rail that keeps every main destination one click away. */
export function SidebarRail({ onExpand }: { onExpand: () => void }) {
  const pathname = usePathname()
  const ws = useWorkspace()
  const all = useWorkspaceStore((s) => s.workspaces)
  const modules = useModules()
  const brand = useSettingsStore((s) => s.settings.brand)
  const inProject = !!ws && !isHomeWorkspace(ws, all)
  const visibleModules = modules.filter((m) => m.visible !== false)

  return (
    <div className="rail-in flex h-full w-16 flex-col items-center py-2">
      <AppLink to="/" title={brand.brandName} className="flex size-10 shrink-0 items-center justify-center rounded-lg hover:bg-surface">
        <img src={brand.logo || '/brand/icon.png'} alt={brand.brandName} className="size-7 rounded-lg object-contain" />
      </AppLink>
      <button type="button" onClick={onExpand} aria-label="Expand sidebar" title="Expand sidebar" className="mt-1 flex size-10 shrink-0 items-center justify-center rounded-lg text-muted transition hover:bg-surface hover:text-fg">
        <PanelLeftOpen size={ICON - 4} />
      </button>

      <div className="mt-2 shrink-0"><GeniusStudioButton variant="rail" /></div>

      <nav aria-label="Main navigation" className="scroll-thin mt-2 flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto py-1">
        {!inProject && <RailItem to="/overview" label="Dashboard" active={pathname === '/overview'}><DashboardIcon size={ICON} /></RailItem>}
        <RailItem to="/modules" label="Modules" active={inModules(pathname)}><ModulesIcon size={ICON} /></RailItem>
        <RailItem to="/tools" label="Tools" active={inTools(pathname)}><ToolsIcon size={ICON} /></RailItem>
        <RailItem to="/settings" label="Settings" active={inSettings(pathname)}><SettingsIcon size={ICON} /></RailItem>
        <div className="my-1 h-px w-7 bg-line" aria-hidden />
        <RailItem to="/projects" label="My projects" active={isActive(pathname, '/projects')}><Icon name="FolderKanban" size={ICON} /></RailItem>
        <RailItem to="/history" label="History" active={isActive(pathname, '/history')}><Icon name="History" size={ICON} /></RailItem>
        {inProject && (
          <>
            <div className="my-1 h-px w-7 bg-line" aria-hidden />
            <RailItem to="/overview" label={`${ws?.name ?? 'Project'} overview`} active={pathname === '/overview'}><DashboardIcon size={ICON} /></RailItem>
            {visibleModules.map((m) => (
              <RailItem key={m.id} to={`/m/${m.id}`} label={m.name} active={isActive(pathname, `/m/${m.id}`)}><Icon name={m.icon} size={ICON} /></RailItem>
            ))}
          </>
        )}
      </nav>

      <div className="flex shrink-0 flex-col items-center gap-1 border-t border-line pt-2">
        <ThemeToggle className="size-10" />
        <AccountMenu compact />
      </div>
    </div>
  )
}
