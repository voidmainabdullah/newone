import { DEFAULT_SECTIONS } from '#/services/navService'
import { Page } from '#/components/layout/Page'
import { AppLink } from '#/components/layout/AppLink'
import { PageHeader } from '#/components/ui/misc'
import { Icon } from '#/components/ui/Icon'

const ABOUT: Record<string, string> = {
  search: 'Find any record, module or page',
  recent: 'Pick up where you left off',
  favourites: 'Your pinned records and modules',
  dashboards: 'Build and arrange your dashboards',
  reports: 'Saved reports on your records',
  analytics: 'Charts and trends for every module',
  forms: 'Collect data with shareable forms',
  views: 'Saved tables, boards and calendars',
  workflows: 'Automate follow-ups and updates',
  'data-flow': 'See how records connect',
  'import-export': 'Bring data in or take a copy out',
  templates: 'Start from a ready-made CRM',
  integrations: 'Connect other apps',
}

/** Every tool in one place (the same tools are also listed under Tools in the sidebar). */
export function ToolsPage() {
  const items = DEFAULT_SECTIONS.find((s) => s.key === 'tools')?.items ?? []
  return (
    <Page title="Tools">
      <PageHeader title="Tools" icon="Wrench" description="Everything you use to work with your records." />
      <div className="stagger grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((i) => (
          <AppLink key={i.key} to={i.path} className="group flex items-start gap-3 rounded-xl bg-surface p-4 transition hover:bg-subtle">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-subtle text-muted transition group-hover:bg-app group-hover:text-fg"><Icon name={i.icon} size={17} /></span>
            <span className="min-w-0">
              <span className="block text-[13.5px] font-medium">{i.label}</span>
              <span className="mt-0.5 block text-xs text-muted">{ABOUT[i.key] ?? ''}</span>
            </span>
          </AppLink>
        ))}
      </div>
    </Page>
  )
}
