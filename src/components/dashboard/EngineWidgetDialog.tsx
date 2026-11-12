import { useMemo, useState } from 'react'
import type { Module } from '#/types'
import { AGGREGATIONS, WIDGET_KINDS, type Calculation, type DashboardWidgetShape, type WidgetFormat, type WidgetKind, type WidgetSource } from '#/engine/schema'
import { validateWidget } from '#/engine/dashboardService'
import { buildRange, finalizeWidget, isNumericFieldType, RANGE_OPTIONS, rangeParts, sourceFromCalculation } from '#/engine/widgetForm'
import { WIDGET_LABELS, WIDGET_NEEDS } from '#/engine/widgets'
import { Button } from '#/components/ui/Button'
import { Modal } from '#/components/ui/Modal'
import { Field as FormField, Input, Select } from '#/components/ui/controls'
import { ConditionGroupEditor } from '#/components/engine/ConditionEditor'

const AGG_LABEL: Record<(typeof AGGREGATIONS)[number], string> = { count: 'Count of records', sum: 'Sum', average: 'Average', min: 'Smallest', max: 'Largest' }

/**
 * Add or edit one dashboard widget: type, module, field, aggregation, group by, filters, date range (this month, last 30 days,
 * this year or custom), display format and title. The result is validated against the real project while you type; Save stays
 * disabled until it is valid.
 */
export function EngineWidgetDialog({ ws, widget, modules, calculations, isNew, onSave, onClose }: { ws: string; widget: DashboardWidgetShape; modules: Module[]; calculations: Calculation[]; isNew: boolean; onSave: (w: DashboardWidgetShape) => void; onClose: () => void }) {
  const start = useMemo(() => {
    // an inline calculation is edited with the same source controls
    if (widget.type === 'calculation' && widget.calculation && typeof widget.calculation === 'object') return { w: { ...widget, source: sourceFromCalculation(widget.calculation) }, mode: 'inline' as const, ref: undefined }
    // a calculation widget with nothing saved to pick from starts as an inline one
    const noSaved = widget.type === 'calculation' && !widget.calculation && calculations.length === 0
    return { w: widget, mode: (noSaved ? 'inline' : 'saved') as 'saved' | 'inline', ref: typeof widget.calculation === 'string' ? widget.calculation : undefined }
  }, [widget, calculations.length])
  const [w, setW] = useState<DashboardWidgetShape>(start.w)
  const [mode, setMode] = useState<'saved' | 'inline'>(start.mode)
  const [ref, setRef] = useState<string | undefined>(start.ref ?? calculations[0]?.name)
  const needs = WIDGET_NEEDS[w.type]
  const inline = w.type === 'calculation' && mode === 'inline'
  const showSource = needs.module || inline
  const source: WidgetSource = w.source ?? {}
  const module = modules.find((m) => m.id === source.entity || m.name === source.entity)
  const range = rangeParts(source.dateRange)
  const numeric = module?.fields.filter((f) => isNumericFieldType(f.type)) ?? []
  const dates = module?.fields.filter((f) => f.type === 'date' || f.type === 'datetime') ?? []
  const groupable = module?.fields.filter((f) => !['longText', 'password', 'file', 'image', 'document', 'signature'].includes(f.type)) ?? []

  const setSource = (patch: Partial<WidgetSource>) => setW((cur) => ({ ...cur, source: { ...cur.source, ...patch } }))
  const setRange = (patch: Partial<typeof range>) => setSource({ dateRange: buildRange({ ...range, ...patch }) })
  const setType = (type: WidgetKind) => setW((cur) => ({ ...cur, type, title: cur.title === WIDGET_LABELS[cur.type].label ? WIDGET_LABELS[type].label : cur.title }))
  const setFormat = (patch: Partial<Omit<WidgetFormat, 'kind'>> & { kind?: WidgetFormat['kind'] | '' }) => setW((cur) => {
    const next = { ...(cur.format ?? { kind: 'number' as const }), ...patch }
    return { ...cur, format: !next.kind ? undefined : (next as WidgetFormat) }
  })
  const setModule = (id: string) => setSource({ entity: id, field: undefined, groupBy: undefined, expenseField: undefined, filters: undefined, dateField: undefined, dateRange: undefined })

  const final = useMemo(() => finalizeWidget(w, { mode, ref }), [w, mode, ref])
  const errors = useMemo(() => (w.title.trim() ? validateWidget(ws, final) : [{ path: 'title', message: 'Give the widget a title' }]), [ws, final, w.title])
  const sourceFields = showSource && !!module

  return (
    <Modal open onClose={onClose} size="lg" title={isNew ? 'Add a widget' : `Edit widget: ${widget.title}`} description="Choose what to show. The numbers come straight from your records."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={errors.length > 0} onClick={() => onSave({ ...final, title: final.title.trim() })}>{isNew ? 'Add widget' : 'Save widget'}</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Widget type">
            <Select aria-label="Widget type" value={w.type} onChange={(e) => setType(e.target.value as WidgetKind)}>
              {WIDGET_KINDS.map((k) => <option key={k} value={k}>{WIDGET_LABELS[k].label}</option>)}
            </Select>
          </FormField>
          <FormField label="Title" required><Input aria-label="Title" value={w.title} onChange={(e) => setW({ ...w, title: e.target.value })} /></FormField>
        </div>
        <p className="-mt-2 text-xs text-muted">{WIDGET_LABELS[w.type].hint}</p>

        {w.type === 'calculation' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Calculation">
              <Select aria-label="Calculation source" value={mode === 'saved' ? ref ?? '' : '__inline'} onChange={(e) => { if (e.target.value === '__inline') setMode('inline'); else { setMode('saved'); setRef(e.target.value) } }}>
                {calculations.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
                <option value="__inline">Build one here…</option>
              </Select>
            </FormField>
          </div>
        )}

        {showSource && (
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Module">
              <Select aria-label="Module" value={module?.id ?? ''} onChange={(e) => setModule(e.target.value)}>
                {!module && <option value="">Choose a module…</option>}
                {modules.filter((m) => !m.archived).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </Select>
            </FormField>
            {(needs.field !== 'none' || inline) && (
              <FormField label={needs.field === 'required' ? 'Field' : 'Field (optional for counts)'}>
                <Select aria-label="Field" disabled={!module} value={source.field ?? ''} onChange={(e) => setSource({ field: e.target.value || undefined })}>
                  <option value="">{needs.field === 'required' ? 'Choose a field…' : 'Count records'}</option>
                  {numeric.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                </Select>
              </FormField>
            )}
            {(needs.aggregation || inline) && (
              <FormField label="Calculation">
                <Select aria-label="Aggregation" disabled={!module} value={source.aggregation ?? (source.field ? 'sum' : 'count')} onChange={(e) => setSource({ aggregation: e.target.value as (typeof AGGREGATIONS)[number] })}>
                  {AGGREGATIONS.map((a) => <option key={a} value={a}>{AGG_LABEL[a]}</option>)}
                </Select>
              </FormField>
            )}
            {needs.expense && (
              <FormField label="Expense field">
                <Select aria-label="Expense field" disabled={!module} value={source.expenseField ?? ''} onChange={(e) => setSource({ expenseField: e.target.value || undefined })}>
                  <option value="">Choose a field…</option>
                  {numeric.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                </Select>
              </FormField>
            )}
            {(needs.groupBy || (inline && source.groupBy)) && (
              <FormField label={w.type === 'line_chart' ? 'Over time by' : 'Group by'}>
                <Select aria-label="Group by" disabled={!module} value={source.groupBy ?? ''} onChange={(e) => setSource({ groupBy: e.target.value || undefined })}>
                  <option value="">{w.type === 'line_chart' ? 'Created date' : 'Choose a field…'}</option>
                  {(w.type === 'line_chart' ? dates : groupable).map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                </Select>
              </FormField>
            )}
            {w.type === 'line_chart' && (
              <FormField label="Points per">
                <Select aria-label="Bucket" value={range.bucket ?? 'month'} onChange={(e) => setRange({ bucket: e.target.value as 'day' | 'week' | 'month' | 'year' })}>
                  {['day', 'week', 'month', 'year'].map((b) => <option key={b} value={b}>{b}</option>)}
                </Select>
              </FormField>
            )}
            {w.type === 'progress' && <FormField label="Target"><Input aria-label="Target" type="number" value={w.target ?? ''} onChange={(e) => setW({ ...w, target: e.target.value === '' ? undefined : Number(e.target.value) })} /></FormField>}
            {(w.type === 'table' || w.type === 'recent_records') && <FormField label="Rows"><Input aria-label="Rows" type="number" min={1} max={100} value={w.limit ?? ''} onChange={(e) => setW({ ...w, limit: e.target.value === '' ? undefined : Number(e.target.value) })} /></FormField>}
          </div>
        )}

        {w.type === 'recent_activity' && <FormField label="Items"><Input aria-label="Items" type="number" min={1} max={100} value={w.limit ?? 8} onChange={(e) => setW({ ...w, limit: Number(e.target.value) || 8 })} className="w-28" /></FormField>}

        {sourceFields && (needs.range || inline) && (
          <div className="grid gap-3 sm:grid-cols-3">
            <FormField label="Date range">
              <Select aria-label="Date range" value={range.preset} onChange={(e) => setRange({ preset: e.target.value as typeof range.preset })}>
                {RANGE_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </Select>
            </FormField>
            {range.preset === 'custom' && (
              <>
                <FormField label="From"><Input aria-label="From" type="date" value={range.from ?? ''} onChange={(e) => setRange({ from: e.target.value || undefined })} /></FormField>
                <FormField label="To"><Input aria-label="To" type="date" value={range.to ?? ''} onChange={(e) => setRange({ to: e.target.value || undefined })} /></FormField>
              </>
            )}
            {range.preset !== 'all' && dates.length > 0 && (
              <FormField label="Date field">
                <Select aria-label="Date field" value={range.field ?? ''} onChange={(e) => setRange({ field: e.target.value || undefined })}>
                  <option value="">Created date</option>
                  {dates.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                </Select>
              </FormField>
            )}
          </div>
        )}

        {sourceFields && (needs.filters || inline) && (
          <ConditionGroupEditor module={module!} label="Only records where" value={{ logic: 'AND', nodes: source.filters ?? [] }} onChange={(g) => setSource({ filters: g.nodes.length ? (g.logic === 'OR' && g.nodes.length > 1 ? [{ logic: 'OR', conditions: g.nodes }] : g.nodes) : undefined })} />
        )}

        {(sourceFields || w.type === 'calculation') && !['table', 'recent_records', 'recent_activity', 'percentage'].includes(w.type) && (
          <div className="grid gap-3 sm:grid-cols-3">
            <FormField label="Show as">
              <Select aria-label="Display format" value={w.format?.kind ?? ''} onChange={(e) => setFormat({ kind: e.target.value as WidgetFormat['kind'] | '' })}>
                <option value="">Automatic</option>
                <option value="number">Number</option>
                <option value="currency">Currency</option>
                <option value="percent">Percent</option>
              </Select>
            </FormField>
            {w.format && <FormField label="Decimals"><Input aria-label="Decimals" type="number" min={0} max={8} value={w.format.precision ?? ''} onChange={(e) => setFormat({ precision: e.target.value === '' ? undefined : Number(e.target.value) })} /></FormField>}
            {w.format?.kind === 'currency' && <FormField label="Currency"><Input aria-label="Currency" maxLength={3} value={w.format.currency ?? ''} placeholder="USD" onChange={(e) => setFormat({ currency: e.target.value.toUpperCase() || undefined })} /></FormField>}
          </div>
        )}

        {errors.length > 0 && w.title.trim() && (
          <div role="alert" className="rounded-lg border border-danger/30 bg-danger/5 p-3 text-[13px]">
            <div className="mb-1 font-semibold text-danger">Fix this to continue</div>
            <ul className="space-y-1">{errors.slice(0, 6).map((e, i) => <li key={i} className="flex gap-2"><code className="shrink-0 rounded bg-subtle px-1.5 text-[12px] text-muted">{e.path.replace(/^widget\./, '')}</code><span>{e.message}</span></li>)}</ul>
          </div>
        )}
      </div>
    </Modal>
  )
}
