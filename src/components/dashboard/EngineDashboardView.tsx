import { useState } from 'react'
import { useAllModules } from '#/hooks/useData'
import { useEngineStore } from '#/stores/engineStore'
import { addWidget, newWidget, updateWidget } from '#/engine/dashboardOps'
import { saveDashboardLayout } from '#/engine/dashboardService'
import type { DashboardWidgetShape, EngineDashboard, WidgetKind } from '#/engine/schema'
import { WIDGET_KINDS } from '#/engine/schema'
import { WIDGET_LABELS } from '#/engine/widgets'
import { toast } from '#/utils/toast'
import { Button } from '#/components/ui/Button'
import { Icon } from '#/components/ui/Icon'
import { Modal } from '#/components/ui/Modal'
import { EmptyState } from '#/components/ui/misc'
import { EngineDashboardGrid } from './EngineDashboardGrid'
import { EngineWidgetDialog } from './EngineWidgetDialog'

/**
 * One engine dashboard for one user: the widget grid, the "add a widget" picker and the widget dialog. Every layout edit is
 * validated and saved through the dashboard service (a shared dashboard is forked into the user's own copy on first save).
 * The page owns the header buttons and tells this view whether it is in edit mode and whether to open the picker.
 */
export function EngineDashboardView({ ws, dashboard, userId, editing, picking, onPickClose, onEditRequest, canManage, onSaved }: { ws: string; dashboard: EngineDashboard; userId: string; editing: boolean; picking: boolean; onPickClose: () => void; onEditRequest: () => void; canManage: boolean; onSaved?: (d: EngineDashboard) => void }) {
  const modules = useAllModules().filter((m) => !m.archived)
  const docs = useEngineStore((s) => s.docs)
  const calculations = docs.find((d) => d.id === ws)?.calculations ?? []
  const [dialog, setDialog] = useState<{ widget: DashboardWidgetShape; isNew: boolean } | null>(null)

  const persist = (widgets: DashboardWidgetShape[]) => {
    const res = saveDashboardLayout(ws, userId, dashboard.id, { widgets })
    if (!res.ok) {
      toast.error('Could not save the dashboard', res.errors[0]?.message)
      return false
    }
    if (res.dashboard) onSaved?.(res.dashboard)
    return true
  }
  const pick = (type: WidgetKind) => {
    onPickClose()
    setDialog({ widget: newWidget(type, modules), isNew: true })
  }

  return (
    <>
      {dashboard.widgets.length === 0 ? (
        <EmptyState icon="LayoutDashboard" title="This dashboard is empty" description={canManage ? 'Add widgets to start tracking your numbers.' : 'Ask an admin to add widgets.'} action={canManage && <Button variant="primary" icon="Plus" onClick={onEditRequest}>Add widget</Button>} />
      ) : (
        <EngineDashboardGrid ws={ws} widgets={dashboard.widgets} editing={editing && canManage} onChange={(next) => void persist(next)} onConfigure={(w) => setDialog({ widget: w, isNew: false })} />
      )}

      <Modal open={picking} onClose={onPickClose} size="lg" title="Add a widget" description="Pick what to show. You choose the module, field and period next.">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {WIDGET_KINDS.map((k) => (
            <button key={k} type="button" onClick={() => pick(k)} className="rounded-xl border border-line p-3 text-left transition hover:border-primary hover:bg-subtle">
              <Icon name={WIDGET_LABELS[k].icon} size={18} className="text-link" />
              <div className="mt-1.5 text-[13px] font-semibold">{WIDGET_LABELS[k].label}</div>
              <div className="text-[11px] text-muted">{WIDGET_LABELS[k].hint}</div>
            </button>
          ))}
        </div>
      </Modal>

      {dialog && (
        <EngineWidgetDialog
          key={dialog.widget.id}
          ws={ws}
          widget={dialog.widget}
          modules={modules}
          calculations={calculations}
          isNew={dialog.isNew}
          onClose={() => setDialog(null)}
          onSave={(w) => {
            if (persist(dialog.isNew ? addWidget(dashboard.widgets, w) : updateWidget(dashboard.widgets, w))) {
              setDialog(null)
              toast.success(dialog.isNew ? 'Widget added' : 'Widget saved')
            }
          }}
        />
      )}
    </>
  )
}
