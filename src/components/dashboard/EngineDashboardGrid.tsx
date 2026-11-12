import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { rectSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Copy, Eye, EyeOff, GripVertical, Maximize2, Settings2, Trash2 } from 'lucide-react'
import { duplicateWidget, moveWidget, removeWidget, resizeWidget, setWidgetEnabled, sortedWidgets } from '#/engine/dashboardOps'
import type { DashboardWidgetShape } from '#/engine/schema'
import { cn } from '#/utils/id'
import { Menu } from '#/components/ui/Popover'
import { EngineWidgetView } from './EngineWidget'
import { widgetHeight } from './WidgetView'

/** 1 column on phones, 2 on tablets, 4 on desktops; a wide widget takes as many of those as exist */
const SPAN: Record<number, string> = {
  1: '',
  2: 'sm:col-span-2',
  3: 'sm:col-span-2 lg:col-span-3',
  4: 'sm:col-span-2 lg:col-span-4',
}

interface TileProps {
  ws: string
  widget: DashboardWidgetShape
  editing: boolean
  index: number
  count: number
  onChange: (next: DashboardWidgetShape[]) => void
  list: DashboardWidgetShape[]
  onConfigure: (w: DashboardWidgetShape) => void
}

function Tile({ ws, widget: w, editing, index, count, list, onChange, onConfigure }: TileProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: w.id, disabled: !editing })
  const off = w.enabled === false
  const sizeItems = [
    ...[1, 2, 3, 4].map((n) => ({ label: `Width: ${n} column${n > 1 ? 's' : ''}`, checked: w.layout.w === n, onClick: () => onChange(resizeWidget(list, w.id, { w: n })) })),
    { divider: true },
    ...[1, 2, 3].map((n) => ({ label: `Height: ${n} row${n > 1 ? 's' : ''}`, checked: w.layout.h === n, onClick: () => onChange(resizeWidget(list, w.id, { h: n })) })),
    { divider: true },
    { label: 'Move earlier', disabled: index === 0, onClick: () => onChange(moveWidget(list, w.id, list[index - 1].id)) },
    { label: 'Move later', disabled: index === count - 1, onClick: () => onChange(moveWidget(list, w.id, list[index + 1].id)) },
  ]
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, height: widgetHeight(w.layout.h) }}
      data-widget={w.id}
      className={cn('flex min-w-0 flex-col rounded-xl border bg-surface p-3', SPAN[w.layout.w], editing ? 'border-dashed border-line-strong' : 'border-line', off && 'opacity-50', isDragging && 'z-10 opacity-60 shadow-pop')}
    >
      <div className="mb-2 flex shrink-0 items-center gap-1">
        {editing && <button type="button" aria-label={`Drag ${w.title}. Press space, then the arrow keys, to move it.`} className="cursor-grab touch-none rounded p-0.5 text-muted hover:text-fg" {...attributes} {...listeners}><GripVertical size={15} /></button>}
        <h3 className="min-w-0 flex-1 truncate text-[13px] font-semibold">{w.title}{off && <span className="ml-1.5 text-[11px] font-normal text-muted">(off)</span>}</h3>
        {editing && (
          <div className="flex shrink-0">
            <Menu width={190} items={sizeItems} trigger={({ toggle, ref }) => <button ref={ref} type="button" aria-label={`Size of ${w.title}`} title="Size and position" onClick={toggle} className="rounded p-1 text-muted hover:bg-subtle"><Maximize2 size={13} /></button>} />
            <button type="button" aria-label={off ? `Show ${w.title}` : `Hide ${w.title}`} title={off ? 'Show' : 'Hide'} onClick={() => onChange(setWidgetEnabled(list, w.id, off))} className="rounded p-1 text-muted hover:bg-subtle">{off ? <EyeOff size={13} /> : <Eye size={13} />}</button>
            <button type="button" aria-label={`Duplicate ${w.title}`} title="Duplicate" onClick={() => onChange(duplicateWidget(list, w.id))} className="rounded p-1 text-muted hover:bg-subtle"><Copy size={13} /></button>
            <button type="button" aria-label={`Settings for ${w.title}`} title="Settings" onClick={() => onConfigure(w)} className="rounded p-1 text-muted hover:bg-subtle"><Settings2 size={13} /></button>
            <button type="button" aria-label={`Remove ${w.title}`} title="Remove" onClick={() => onChange(removeWidget(list, w.id))} className="rounded p-1 text-muted hover:bg-danger/10 hover:text-danger"><Trash2 size={13} /></button>
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1"><EngineWidgetView widget={w} ws={ws} editing={editing} /></div>
    </div>
  )
}

/**
 * The responsive widget grid of an engine dashboard. In edit mode widgets can be reordered by dragging or with the keyboard
 * (grip button: space, arrows, space), resized from the size menu, duplicated, hidden and removed. Every change is handed to
 * `onChange` as a new, renumbered list; the page validates and saves it.
 */
export function EngineDashboardGrid({ ws, widgets, editing, onChange, onConfigure }: { ws: string; widgets: DashboardWidgetShape[]; editing: boolean; onChange: (next: DashboardWidgetShape[]) => void; onConfigure: (w: DashboardWidgetShape) => void }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))
  const sorted = sortedWidgets(widgets)
  const shown = editing ? sorted : sorted.filter((w) => w.enabled !== false)
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return
    onChange(moveWidget(sorted, String(e.active.id), String(e.over.id)))
  }
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={shown.map((w) => w.id)} strategy={rectSortingStrategy}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="engine-grid">
          {shown.map((w, i) => <Tile key={w.id} ws={ws} widget={w} editing={editing} index={i} count={shown.length} list={sorted} onChange={onChange} onConfigure={onConfigure} />)}
        </div>
      </SortableContext>
    </DndContext>
  )
}
