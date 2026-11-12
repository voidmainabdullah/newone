import { useEffect, type ReactNode } from 'react'
import { LogOut, Pencil, PanelLeftClose, X } from 'lucide-react'
import { useCurrentUser, useModules, useRoles, useWorkspace } from '#/hooks/useData'
import { useUiStore } from '#/stores/uiStore'
import { useUserStore } from '#/stores/userStore'
import { useSettingsStore } from '#/stores/settingsStore'
import { useWorkspaceStore } from '#/stores/workspaceStore'
import { signOut, useAuthStore } from '#/genius/auth/authStore'
import { DEFAULT_SECTIONS } from '#/services/navService'
import { isHomeWorkspace } from '#/services/workspaceService'
import { Icon } from '#/components/ui/Icon'
import { Popover } from '#/components/ui/Popover'
import { Avatar } from '#/components/ui/misc'
import { cn } from '#/utils/id'
import { AppLink, usePathname } from './AppLink'
import { NavTree } from './NavTree'
import { DashboardIcon, ModulesIcon, SettingsIcon, ToolsIcon } from './NavIcons'
import { GeniusStudioButton } from './GeniusStudioButton'
import { ThemeToggle } from './ThemeToggle'

export function Brand({ compact }: { compact?: boolean }) {
  const brand = useSettingsStore((s) => s.settings.brand)
  return (
    <AppLink to="/" className="flex items-center gap-2.5">
      <img src={brand.logo || '/brand/icon.png'} alt={brand.brandName} className="size-7 rounded-lg object-contain" />
      {!compact && <span className="text-[15px] font-medium tracking-tight">{brand.brandName}</span>}
    </AppLink>
  )
}

function Item({ to, icon, label, active, onClick, count }: { to: string; icon: string; label: string; active: boolean; onClick?: () => void; count?: number }) {
  return (
    <AppLink to={to} onClick={onClick} className={cn('flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13px] transition', active ? 'bg-subtle text-fg' : 'text-muted hover:bg-surface hover:text-fg')}>
      <Icon name={icon} size={16} />
      <span className="flex-1 truncate">{label}</span>
      {count != null && count > 0 && <span className="text-[11px] text-muted-2 tabular-nums">{count}</span>}
    </AppLink>
  )
}

export const isActive = (pathname: string, path: string) => (path === '/' ? pathname === '/' : pathname === path || pathname.startsWith(path + '/'))

export function AccountMenu({ compact }: { compact?: boolean } = {}) {
  const email = useAuthStore((s) => s.email)
  const user = useCurrentUser()
  const users = useUserStore((s) => s.users)
  const roles = useRoles()
  const updateUser = useUserStore((s) => s.updateUser)
  const setCurrentUser = useSettingsStore((s) => s.setCurrentUser)
  const role = roles.find((r) => r.id === user?.roleId)
  return (
    <Popover
      width={264}
      trigger={({ toggle, ref }) => (
        <button ref={ref} type="button" onClick={toggle} aria-label="Account and role" title={compact ? (user?.name ?? 'Account') : undefined} className={cn('flex items-center rounded-lg text-left transition hover:bg-surface', compact ? 'size-10 justify-center' : 'w-full gap-2.5 px-2 py-1.5')}>
          <Avatar name={user?.name ?? email ?? '?'} color={user?.color} size={compact ? 28 : 26} />
          {!compact && <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-[13px]">{user?.name ?? 'Account'}</span>
            <span className="block truncate text-[11px] text-muted-2">{email ?? role?.name}</span>
          </span>}
        </button>
      )}
    >
      {(close) => (
        <div>
          <div className="section-label px-2.5 py-1.5">Acting as</div>
          {users.map((u) => (
            <button key={u.id} type="button" onClick={() => { setCurrentUser(u.id); close() }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-subtle">
              <Avatar name={u.name} color={u.color} size={20} />
              <span className="flex-1 truncate">{u.name}</span>
              <span className="text-[11px] text-muted">{roles.find((r) => r.id === u.roleId)?.name}</span>
              {u.id === user?.id && <Icon name="Check" size={14} className="text-link" />}
            </button>
          ))}
          <div className="my-1 h-px bg-line" />
          <div className="section-label px-2.5 py-1.5">Role for {user?.name}</div>
          {roles.map((r) => (
            <button key={r.id} type="button" onClick={() => { if (user) updateUser(user.id, { roleId: r.id }); close() }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-subtle">
              <span className="flex-1">{r.name}</span>
              {r.id === user?.roleId && <Icon name="Check" size={14} className="text-link" />}
            </button>
          ))}
          <p className="mt-1 px-2.5 py-1.5 text-[11px] leading-snug text-muted-2">Roles tidy the interface in this browser. They are not server-side security.</p>
          <div className="my-1 h-px bg-line" />
          <button type="button" onClick={() => void signOut()} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-subtle"><LogOut size={14} className="text-muted" />Sign out</button>
        </div>
      )}
    </Popover>
  )
}

const TOOL_ITEMS = DEFAULT_SECTIONS.find((s) => s.key === 'tools')?.items ?? []
/** the Settings area's own pages (the module list is the Modules item, the settings page itself is the Settings item) */
const SETTINGS_ITEMS = (DEFAULT_SECTIONS.find((s) => s.key === 'settings')?.items ?? []).filter((i) => i.key !== 'modules' && i.key !== 'settings')
export const inTools = (p: string) => p === '/tools' || TOOL_ITEMS.some((i) => isActive(p, i.path))
export const inSettings = (p: string) => p === '/settings' || SETTINGS_ITEMS.some((i) => isActive(p, i.path))
export const inModules = (p: string) => p === '/modules' || p.startsWith('/m/')

function MainItem({ to, label, icon, active, onClick }: { to: string; label: string; icon: ReactNode; active: boolean; onClick?: () => void }) {
  return (
    <AppLink to={to} onClick={onClick} className={cn('group flex items-center gap-3 rounded-lg px-2.5 py-2 text-[13.5px] font-medium transition-all duration-200', active ? 'bg-subtle text-fg' : 'text-muted hover:bg-surface hover:text-fg')}>
      <span className={cn('flex size-[18px] shrink-0 items-center justify-center transition-transform duration-200', !active && 'opacity-80 group-hover:scale-110 group-hover:opacity-100')}>{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {active && <span className="size-1.5 rounded-full bg-fg/60" aria-hidden />}
    </AppLink>
  )
}

function SubItem({ to, label, active, onClick }: { to: string; label: string; active: boolean; onClick?: () => void }) {
  return (
    <AppLink to={to} onClick={onClick} className={cn('block truncate rounded-md py-1 pr-2 pl-2.5 text-[12.5px] transition', active ? 'bg-subtle/70 text-fg' : 'text-muted hover:text-fg')}>{label}</AppLink>
  )
}

/** Sidebar: Genius Studio, then Dashboard (only when no project is open), Modules, Tools and Settings, then the open project's own section (Overview first, then its modules). */
export function Sidebar({ mobile, onHide }: { mobile?: boolean; onHide?: () => void }) {
  const pathname = usePathname()
  const ws = useWorkspace()
  const all = useWorkspaceStore((s) => s.workspaces)
  const modules = useModules()
  const editing = useUiStore((s) => s.navEditing)
  const setEditing = useUiStore((s) => s.setNavEditing)
  const setMobile = useUiStore((s) => s.setMobileNav)
  const projects = all.filter((w) => !isHomeWorkspace(w, all)).length
  const inProject = !!ws && !isHomeWorkspace(ws, all)
  const close = mobile ? () => setMobile(false) : undefined
  const tools = inTools(pathname)
  const settings = inSettings(pathname)

  useEffect(() => {
    // projects built earlier kept their modules in a folder called "AI-built": name it after the project instead
    if (!ws || !inProject) return
    const st = useSettingsStore.getState()
    const old = st.getNav(ws.id).find((i) => i.type === 'category' && i.label === 'AI-built')
    if (old) st.updateNavItem(ws.id, old.id, { label: ws.name })
  }, [ws, inProject])

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between px-4">
        <Brand />
        {mobile ? (
          <button type="button" aria-label="Close menu" onClick={() => setMobile(false)} className="rounded-lg p-1.5 text-muted hover:bg-surface hover:text-fg"><X size={16} /></button>
        ) : (
          onHide && <button type="button" aria-label="Collapse sidebar" title="Collapse sidebar" onClick={onHide} className="rounded-lg p-1.5 text-muted hover:bg-surface hover:text-fg"><PanelLeftClose size={16} /></button>
        )}
      </div>

      <div className="shrink-0 px-3 pt-1 pb-2"><GeniusStudioButton onDone={close} /></div>

      <nav aria-label="Main navigation" className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto px-2.5 pt-1 pb-4">
        <div className="space-y-0.5">
          {!inProject && <MainItem to="/overview" label="Dashboard" icon={<DashboardIcon />} active={pathname === '/overview'} onClick={close} />}
          <MainItem to="/modules" label="Modules" icon={<ModulesIcon />} active={inModules(pathname)} onClick={close} />
          <MainItem to="/tools" label="Tools" icon={<ToolsIcon />} active={tools} onClick={close} />
          {tools && (
            <div className="ml-[18px] space-y-0.5 border-l border-line py-1 pl-2.5" aria-label="Tools">
              {TOOL_ITEMS.map((i) => <SubItem key={i.key} to={i.path} label={i.label} active={isActive(pathname, i.path)} onClick={close} />)}
            </div>
          )}
          <MainItem to="/settings" label="Settings" icon={<SettingsIcon />} active={settings} onClick={close} />
          {settings && (
            <div className="ml-[18px] space-y-0.5 border-l border-line py-1 pl-2.5" aria-label="Settings">
              <SubItem to="/settings" label="General" active={pathname === '/settings'} onClick={close} />
              {SETTINGS_ITEMS.map((i) => <SubItem key={i.key} to={i.path} label={i.label} active={isActive(pathname, i.path)} onClick={close} />)}
            </div>
          )}
        </div>

        <div className="space-y-0.5">
          <Item to="/projects" icon="FolderKanban" label="My projects" active={isActive(pathname, '/projects')} onClick={close} count={projects} />
          <Item to="/history" icon="History" label="History" active={isActive(pathname, '/history')} onClick={close} />
        </div>

        {inProject && (
          <div>
            <div className="section-label flex items-center justify-between px-2.5 pb-1.5">
              <span className="truncate">{ws?.name}</span>
              {modules.length > 0 && (
                <button type="button" aria-label={editing ? 'Done customising' : 'Customise navigation'} title={editing ? 'Done customising' : 'Customise navigation'} onClick={() => setEditing(!editing)} className={cn('rounded p-1 normal-case hover:text-fg', editing ? 'text-link' : 'text-muted-2')}><Pencil size={12} /></button>
              )}
            </div>
            <div className="pb-0.5">
              <Item to="/overview" icon="LayoutDashboard" label="Overview" active={pathname === '/overview'} onClick={close} />
            </div>
            {modules.length === 0 ? (
              <p className="px-2.5 text-xs leading-relaxed text-muted-2">No modules yet. Describe this project to Genius Studio, or add a module in the builder.</p>
            ) : (
              <NavTree editing={editing} onNavigate={close} />
            )}
          </div>
        )}
      </nav>

      <div className="flex shrink-0 items-center gap-1 border-t border-line p-2">
        <div className="min-w-0 flex-1"><AccountMenu /></div>
        <ThemeToggle />
      </div>
    </div>
  )
}
