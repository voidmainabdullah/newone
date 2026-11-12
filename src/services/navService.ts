import type { ID, NavItem } from '#/types'
import { useSettingsStore } from '#/stores/settingsStore'

type R = { label: string; icon: string; path: string; key: string }
const route = (key: string, label: string, icon: string, path: string): R => ({ key, label, icon, path })

/**
 * The tools and settings pages. They are not stored in any workspace's navigation: the sidebar shows them in one
 * collapsible "Tools" section, in every workspace and project. A workspace's own navigation holds only its modules.
 */
export const DEFAULT_SECTIONS: { key: string; label: string; icon: string; items: R[] }[] = [
  {
    key: 'tools',
    label: 'Tools',
    icon: 'Wrench',
    items: [
      route('search', 'Search', 'Search', '/search'),
      route('recent', 'Recent', 'History', '/recent'),
      route('favourites', 'Favourites', 'Star', '/favourites'),
      route('dashboards', 'Dashboards', 'PieChart', '/dashboards'),
      route('reports', 'Reports', 'FileBarChart', '/reports'),
      route('analytics', 'Analytics', 'LineChart', '/analytics'),
      route('forms', 'Forms', 'FormInput', '/forms'),
      route('views', 'Views', 'Table2', '/views'),
      route('workflows', 'Workflows', 'Workflow', '/workflows'),
      route('data-flow', 'Data flow', 'Network', '/data-flow'),
      route('import-export', 'Import / Export', 'ArrowUpDown', '/import-export'),
      route('templates', 'Templates', 'LayoutTemplate', '/templates'),
      route('integrations', 'Integrations', 'Plug', '/integrations'),
    ],
  },
  {
    key: 'settings',
    label: 'Settings',
    icon: 'Settings',
    items: [
      route('modules', 'All modules', 'Boxes', '/modules'),
      route('module-builder', 'Module builder', 'Hammer', '/module-builder'),
      route('fields', 'Fields', 'Rows3', '/fields'),
      route('team', 'Team', 'Users', '/team'),
      route('roles', 'Roles', 'Lock', '/roles'),
      route('customisation', 'Customisation', 'Paintbrush', '/customisation'),
      route('settings', 'Settings', 'Settings', '/settings'),
    ],
  },
]

/** Bumped whenever the shape of a workspace's stored navigation changes. 5: tools left the navigation. */
export const NAV_REV = 5

/** Route keys / paths that older workspaces stored as sidebar items; they now live in the Tools section. */
const LEGACY_TOOL_KEYS = new Set(['overview', 'search', 'my-workspace', 'recent', 'favourites', 'tasks', 'calendar', 'genius', 'modules', 'module-builder', 'forms', 'fields', 'views', 'workflows', 'data-flow', 'templates', 'dashboards', 'reports', 'analytics', 'team', 'roles', 'customisation', 'integrations', 'import-export', 'settings'])
const LEGACY_CATEGORY_KEYS = new Set(['workspace', 'builder', 'analytics', 'admin', 'business'])

/** One-time cleanup of a workspace saved before the Tools section existed: drops the old default pages and empty default categories. */
export function stripLegacyToolNav(ws: ID) {
  const st = useSettingsStore.getState()
  const nav = st.getNav(ws)
  if (!nav.length) return
  const keep = nav.filter((i) => !(i.type === 'route' && i.key && LEGACY_TOOL_KEYS.has(i.key)))
  const hasChild = (id: ID) => keep.some((i) => i.parentId === id)
  const next = keep.filter((i) => !(i.type === 'category' && i.key && LEGACY_CATEGORY_KEYS.has(i.key) && !hasChild(i.id)))
  if (next.length !== nav.length) st.setNav(ws, next)
}

/** A new workspace has no default navigation: modules add their own entries as they are created. */
export function buildDefaultNav(): NavItem[] {
  return []
}

/** Finds a top-level category by label (case-insensitive) or creates it. */
export function ensureCategory(ws: ID, label: string, icon = 'Folder'): NavItem {
  const st = useSettingsStore.getState()
  const found = st.getNav(ws).find((i) => i.type === 'category' && i.label.toLowerCase() === label.toLowerCase())
  if (found) return found
  return st.addNavItem(ws, { label, icon, type: 'category', parentId: null })
}

export function addModuleNav(ws: ID, moduleId: ID, label: string, icon: string, parentId: ID | null) {
  const st = useSettingsStore.getState()
  if (st.getNav(ws).some((i) => i.moduleId === moduleId)) return
  st.addNavItem(ws, { label, icon, type: 'module', moduleId, parentId })
}
