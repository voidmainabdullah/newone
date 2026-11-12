import type { Module, Widget } from '#/types'

/**
 * Automatic analytics for a workspace, derived from its own modules only (never from another workspace). Every module gets:
 * how many records it holds, the total and average of its money/number fields, how its records split by status/stage,
 * and how many were added over the last 30 days. Relationship fields add a "per parent" breakdown, so the chain of the
 * business (hostel > room > booking > payment) shows up as numbers.
 */
export interface ModuleInsight {
  module: Module
  widgets: Widget[]
}

const MONEY = new Set(['currency'])
const NUMBER = new Set(['number', 'percentage', 'rating'])

let n = 0
const wid = (m: Module, k: string) => `auto_${m.id}_${k}_${++n}`

const base = (m: Module): Pick<Widget, 'moduleId' | 'dateRange' | 'filters' | 'refresh'> => ({ moduleId: m.id, dateRange: 'all', filters: [], refresh: 'live' })

export function insightsFor(modules: Module[]): ModuleInsight[] {
  n = 0
  return modules
    .filter((m) => !m.system && !m.archived)
    .map((m) => {
      const widgets: Widget[] = []
      const fields = m.fields
      widgets.push({ ...base(m), id: wid(m, 'count'), type: 'stat', title: `Total ${m.name.toLowerCase()}`, agg: 'count', w: 1, h: 1, definition: `Number of ${m.name.toLowerCase()} in this workspace` })
      widgets.push({ ...base(m), id: wid(m, 'new'), type: 'stat', title: 'Added in 30 days', agg: 'count', dateRange: '30d', w: 1, h: 1, definition: `${m.name} created in the last 30 days` })
      for (const f of fields.filter((x) => MONEY.has(x.type)).slice(0, 2)) {
        widgets.push({ ...base(m), id: wid(m, 'sum'), type: 'stat', title: `Total ${f.label.toLowerCase()}`, agg: 'sum', fieldId: f.id, w: 1, h: 1, definition: `Sum of ${f.label} across all ${m.name.toLowerCase()}` })
        widgets.push({ ...base(m), id: wid(m, 'avg'), type: 'stat', title: `Average ${f.label.toLowerCase()}`, agg: 'avg', fieldId: f.id, w: 1, h: 1, definition: `Average ${f.label} per record` })
      }
      for (const f of fields.filter((x) => NUMBER.has(x.type)).slice(0, 1)) {
        widgets.push({ ...base(m), id: wid(m, 'nsum'), type: 'stat', title: `Total ${f.label.toLowerCase()}`, agg: 'sum', fieldId: f.id, w: 1, h: 1, definition: `Sum of ${f.label}` })
      }
      const stage = fields.find((f) => f.pipeline) ?? fields.find((f) => f.type === 'dropdown' || f.type === 'radio')
      if (stage) widgets.push({ ...base(m), id: wid(m, 'stage'), type: 'pie', title: `${m.name} by ${stage.label.toLowerCase()}`, agg: 'count', groupBy: stage.id, w: 2, h: 2, definition: `Records of ${m.name} grouped by ${stage.label}` })
      const parent = fields.find((f) => f.relation)
      if (parent) widgets.push({ ...base(m), id: wid(m, 'parent'), type: 'bar', title: `${m.name} per ${parent.label.toLowerCase()}`, agg: 'count', groupBy: parent.id, limit: 8, w: 2, h: 2, definition: `How many ${m.name.toLowerCase()} each ${parent.label} has` })
      else widgets.push({ ...base(m), id: wid(m, 'trend'), type: 'line', title: `New ${m.name.toLowerCase()} over time`, agg: 'count', groupBy: '__createdAt', dateRange: '90d', w: 2, h: 2, definition: `${m.name} created per month over the last 90 days` })
      return { module: m, widgets }
    })
}
