import { useMemo } from 'react'
import { useModules } from '#/hooks/useData'
import { insightsFor } from '#/utils/insights'
import { Card } from '#/components/ui/misc'
import { Icon } from '#/components/ui/Icon'
import { AppLink } from '#/components/layout/AppLink'
import { WidgetView, widgetHeight } from './WidgetView'

/** Overview analytics for the CURRENT workspace only: one block per module, computed live from that workspace's own records. */
export function WorkspaceInsights() {
  const modules = useModules()
  const insights = useMemo(() => insightsFor(modules), [modules])
  if (!insights.length) return null
  return (
    <section className="mb-6 space-y-5" aria-label="Analytics by module">
      <div>
        <h2 className="text-sm font-semibold">Analytics</h2>
        <p className="text-xs text-muted">Live numbers for every module in this workspace. They only use this workspace’s own records.</p>
      </div>
      {insights.map(({ module: m, widgets }) => {
        const stats = widgets.filter((w) => w.type === 'stat')
        const charts = widgets.filter((w) => w.type !== 'stat')
        return (
          <Card key={m.id} className="space-y-3 p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="flex size-8 items-center justify-center rounded-lg" style={{ background: `color-mix(in srgb, ${m.color ?? '#8ab4f8'} 15%, transparent)`, color: m.color ?? '#8ab4f8' }}><Icon name={m.icon} size={16} /></span>
                <h3 className="text-sm font-semibold">{m.name}</h3>
              </div>
              <AppLink to={`/m/${m.id}`} className="text-xs text-link hover:underline">Open</AppLink>
            </div>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {stats.map((w) => (
                <div key={w.id} className="rounded-xl border border-line p-3" title={w.definition}>
                  <div className="text-[12px] text-muted">{w.title}</div>
                  <div className="mt-1" style={{ height: 56 }}><WidgetView w={w} /></div>
                </div>
              ))}
            </div>
            {charts.length > 0 && (
              <div className="grid gap-3 lg:grid-cols-2">
                {charts.map((w) => (
                  <div key={w.id} className="rounded-xl border border-line p-3" title={w.definition}>
                    <div className="mb-1 text-[12px] font-medium">{w.title}</div>
                    <div style={{ height: Math.min(widgetHeight(w.h), 240) }}><WidgetView w={w} /></div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        )
      })}
    </section>
  )
}
