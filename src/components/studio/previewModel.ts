import type { Blueprint } from '#/genius/blueprint/schema'
import type { Module } from '#/types'

/**
 * What the preview draws. It is derived either from a validated blueprint (before anything is published) or from a live
 * project's modules. Records are generated deterministically from the field definitions, so a preview is always the same
 * for the same design; nothing here is ever written to a workspace.
 */
export interface PField { id: string; label: string; type: string; options?: { id: string; label: string }[]; relTo?: string }
export interface PModule { id: string; singular: string; plural: string; icon: string; group: string; kind?: string; fields: PField[]; displayFieldId?: string; stageFieldId?: string; stages?: { id: string; label: string }[] }
export interface PWidget { id: string; title: string; type: string; moduleId: string; agg: string; fieldId?: string; groupByFieldId?: string; w: number; definition: string }
export interface PApp { name: string; modules: PModule[]; widgets: PWidget[]; dashboardName: string }
export type PRow = Record<string, string | number | boolean>

export function fromBlueprint(bp: Blueprint): PApp {
  const modules: PModule[] = bp.modules
    .filter((m) => m.navigation?.show !== false)
    .map((m) => {
      const pipe = bp.pipelines.find((p) => p.moduleId === m.id)
      const rels = bp.relationships.filter((r) => r.sourceModuleId === m.id)
      const fields: PField[] = [
        ...m.fields.map((f) => ({ id: f.id, label: f.label, type: f.type, options: f.options?.map((o) => ({ id: o.id, label: o.label })) })),
        ...rels.filter((r) => !m.fields.some((f) => f.id === r.id)).map((r) => ({ id: r.id, label: r.label, type: 'relation', relTo: r.targetModuleId })),
      ]
      const stageField = pipe && !fields.some((f) => f.id === pipe.id) ? [{ id: pipe.id, label: pipe.stageFieldLabel ?? 'Stage', type: 'dropdown', options: pipe.stages.map((s) => ({ id: s.id, label: s.label })) }] : []
      return {
        id: m.id,
        singular: m.singular,
        plural: m.plural,
        icon: m.icon ?? 'Box',
        group: m.navigation?.group ?? 'Modules',
        kind: m.kind,
        fields: [...fields, ...stageField],
        displayFieldId: m.displayFieldId,
        stageFieldId: pipe?.id,
        stages: pipe?.stages.map((s) => ({ id: s.id, label: s.label })),
      }
    })
  const dash = bp.dashboards[0]
  return {
    name: bp.meta.name,
    modules,
    dashboardName: dash?.name ?? 'Overview',
    widgets: (dash?.components ?? []).map((c) => ({ id: c.id, title: c.title, type: c.type, moduleId: c.moduleId, agg: c.agg, fieldId: c.fieldId, groupByFieldId: c.groupByFieldId, w: c.w, definition: c.definition })),
  }
}

export function fromModules(name: string, mods: Module[]): PApp {
  const modules: PModule[] = mods
    .filter((m) => !m.archived && !m.system)
    .map((m) => ({
      id: m.id,
      singular: m.name.replace(/s$/, ''),
      plural: m.name,
      icon: m.icon,
      group: 'Modules',
      fields: m.fields.map((f) => ({ id: f.id, label: f.label, type: f.type, options: f.options?.map((o) => ({ id: o.id, label: o.label })), relTo: f.relation?.moduleId })),
      stageFieldId: m.fields.find((f) => f.type === 'dropdown')?.id,
      stages: m.fields.find((f) => f.type === 'dropdown')?.options?.map((o) => ({ id: o.id, label: o.label })),
    }))
  return { name, modules, widgets: [], dashboardName: 'Overview' }
}

const FIRST = ['Amelia Hart', 'Noah Carter', 'Priya Nair', 'Lucas Meyer', 'Sofia Rossi', 'Daniel Okafor', 'Mia Tanaka', 'Omar Haddad', 'Chloe Martin', 'Ethan Brooks']
const COMPANIES = ['Northwind', 'Bluebird Studio', 'Harbor & Co', 'Lumen Labs', 'Pinecrest', 'Atlas Works', 'Juniper', 'Kestrel']
const THINGS = ['Alpha', 'Bravo', 'Cedar', 'Delta', 'Ember', 'Fjord', 'Grove', 'Harbor']
const CITIES = ['London', 'Manchester', 'Leeds', 'Bristol', 'Glasgow', 'Cardiff', 'Brighton', 'Oxford']
const SENTENCES = ['Follow up next week.', 'Requested a revised quote.', 'Waiting on documents.', 'Happy with the proposal.', 'Needs a call back.', 'Renewal due soon.']

function dateOffset(i: number, spread = 45) {
  const d = new Date(Date.UTC(2026, 10, 11))
  d.setUTCDate(d.getUTCDate() + ((i * 7) % spread) - Math.floor(spread / 3))
  return d.toISOString().slice(0, 10)
}

function cell(m: PModule, f: PField, i: number): string | number | boolean {
  const lab = f.label.toLowerCase()
  switch (f.type) {
    case 'email': return `${FIRST[i % FIRST.length].toLowerCase().replace(/ /g, '.')}@example.com`
    case 'phone': return `+44 7700 900${String(100 + i * 37).slice(-3)}`
    case 'website': return `${THINGS[i % THINGS.length].toLowerCase()}.example.com`
    case 'number': return /bed|room|seat|qty|quantity|count|unit/.test(lab) ? 1 + ((i * 3) % 6) : 10 + ((i * 17) % 90)
    case 'currency': return 250 + ((i * 410) % 4800)
    case 'percentage': return 5 + ((i * 11) % 60)
    case 'rating': return 3 + (i % 3)
    case 'yesNo': return i % 3 !== 0
    case 'date': return dateOffset(i)
    case 'datetime': return `${dateOffset(i)} 09:${String((i * 7) % 60).padStart(2, '0')}`
    case 'time': return `${8 + (i % 9)}:00`
    case 'dropdown':
    case 'radio': return f.options?.length ? f.options[i % f.options.length].label : '—'
    case 'multiSelect':
    case 'checkboxes':
    case 'tags': return f.options?.length ? [f.options[i % f.options.length].label, f.options[(i + 1) % f.options.length].label].join(', ') : '—'
    case 'user': return FIRST[(i + 3) % FIRST.length]
    case 'address': return `${10 + i} High Street, ${CITIES[i % CITIES.length]}`
    case 'longText': return SENTENCES[i % SENTENCES.length]
    case 'autoId': return `${(f.label.slice(0, 3) || 'ID').toUpperCase()}-${String(1001 + i)}`
    case 'color': return '#8ab4f8'
    case 'file':
    case 'image':
    case 'document':
    case 'signature': return '—'
    default: {
      if (/company|organi[sz]ation|business|account|school|agency|hostel|clinic|studio/.test(lab)) return COMPANIES[i % COMPANIES.length]
      if (/city|location|town|branch/.test(lab)) return CITIES[i % CITIES.length]
      if (/name|contact|owner|guardian|student|tenant|landlord|customer|client|resident|member|patient|employee/.test(lab)) return FIRST[i % FIRST.length]
      if (/status/.test(lab)) return ['Active', 'Pending', 'Closed'][i % 3]
      if (/ref|number|code|id$/.test(lab)) return `${(m.singular.slice(0, 2) || 'R').toUpperCase()}-${String(101 + i)}`
      return `${THINGS[i % THINGS.length]} ${f.label.toLowerCase().slice(0, 14)}`
    }
  }
}

export const ROWS_PER_MODULE = 8

/** Rows for one module. A relationship column shows the matching row of the related module's display column. */
export function rowsFor(app: PApp, m: PModule, count = ROWS_PER_MODULE): PRow[] {
  return Array.from({ length: count }, (_, i) => {
    const row: PRow = {}
    for (const f of m.fields) {
      if (f.type === 'relation' || (f.relTo && !f.options)) {
        const t = app.modules.find((x) => x.id === f.relTo)
        const tf = t ? displayField(t) : undefined
        row[f.id] = t && tf ? String(cell(t, tf, (i * 2 + 1) % count)) : '—'
      } else row[f.id] = cell(m, f, i)
    }
    return row
  })
}

export function displayField(m: PModule): PField | undefined {
  return m.fields.find((f) => f.id === m.displayFieldId) ?? m.fields.find((f) => f.type === 'shortText') ?? m.fields[0]
}

export function formatCell(f: PField, v: string | number | boolean | undefined): string {
  if (v === undefined || v === null || v === '') return '—'
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (f.type === 'currency') return `£${Number(v).toLocaleString('en-GB')}`
  if (f.type === 'percentage') return `${v}%`
  if (f.type === 'rating') return `${v} / 5`
  return String(v)
}

/** The value a stat card shows, computed from the same sample rows the tables show. */
export function widgetValue(app: PApp, w: PWidget): string {
  const m = app.modules.find((x) => x.id === w.moduleId)
  if (!m) return '0'
  const rows = rowsFor(app, m)
  if (w.agg !== 'count' && w.fieldId) {
    const f = m.fields.find((x) => x.id === w.fieldId)
    const nums = rows.map((r) => Number(r[w.fieldId!])).filter((n) => Number.isFinite(n))
    if (f && nums.length) {
      const v = w.agg === 'sum' ? nums.reduce((a, b) => a + b, 0) : w.agg === 'avg' ? nums.reduce((a, b) => a + b, 0) / nums.length : w.agg === 'min' ? Math.min(...nums) : Math.max(...nums)
      return f.type === 'currency' ? `£${Math.round(v).toLocaleString('en-GB')}` : Math.round(v).toLocaleString('en-GB')
    }
  }
  return String(rows.length)
}

/** Counts per value of a grouping field, for the small bar charts. */
export function groupCounts(app: PApp, w: PWidget): { label: string; n: number }[] {
  const m = app.modules.find((x) => x.id === w.moduleId)
  if (!m) return []
  const gid = w.groupByFieldId ?? m.stageFieldId ?? m.fields.find((f) => f.options?.length)?.id
  const f = m.fields.find((x) => x.id === gid)
  if (!f) return []
  const out = new Map<string, number>()
  for (const r of rowsFor(app, m)) out.set(String(r[f.id]), (out.get(String(r[f.id])) ?? 0) + 1)
  return [...out.entries()].map(([label, n]) => ({ label, n }))
}

/** The latest preview, handed to the standalone /preview tab through this browser's storage. */
export const PREVIEW_KEY = 'sortblink:preview'

export function stashPreview(app: PApp): boolean {
  try {
    localStorage.setItem(PREVIEW_KEY, JSON.stringify(app))
    return true
  } catch {
    return false
  }
}
