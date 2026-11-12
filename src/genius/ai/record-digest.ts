import type { CrmRecord, Module } from '#/types'
import { canSeeRecord, fieldAccess, type Actor } from '../permissions/policy'
import { displayValue, makeCtx, recordTitle, valueOf } from '#/utils/records'
import type { User } from '#/types'

/**
 * A compact, READ-ONLY digest of the user's own records, sent only when the user asks a question about their data.
 * Per module: how many records, totals/averages of money and number fields, how records split by status, and a few of the newest
 * records as label -> value. Limited to what the signed-in user may see (module access, record scope, hidden fields).
 */
export interface ModuleDigest {
  module: string
  id: string
  records: number
  totals?: Record<string, { sum: number; avg: number; min: number; max: number }>
  byStatus?: Record<string, Record<string, number>>
  newest: Record<string, string>[]
}

const MAX_SAMPLES = 5
const MAX_FIELDS = 8

export function recordDigest(modules: Module[], records: CrmRecord[], users: User[], actor: Actor, moduleIds?: string[]): ModuleDigest[] {
  const ctx = makeCtx(modules, records, users)
  const picked = modules.filter((m) => !m.system && !m.archived && (!moduleIds?.length || moduleIds.includes(m.id)))
  return picked.map((m) => {
    const rows = records.filter((r) => r.moduleId === m.id && !r.deletedAt && !r.archived && canSeeRecord(actor, m, r))
    const fields = m.fields.filter((f) => fieldAccess(actor.role, f) !== 'hidden')
    const out: ModuleDigest = { module: m.name, id: m.id, records: rows.length, newest: [] }
    const totals: NonNullable<ModuleDigest['totals']> = {}
    for (const f of fields.filter((x) => x.type === 'currency' || x.type === 'number' || x.type === 'percentage').slice(0, 4)) {
      const nums = rows.map((r) => Number(valueOf(m, r, f, ctx))).filter((n) => Number.isFinite(n))
      if (!nums.length) continue
      const sum = nums.reduce((a, b) => a + b, 0)
      totals[f.label] = { sum: Math.round(sum * 100) / 100, avg: Math.round((sum / nums.length) * 100) / 100, min: Math.min(...nums), max: Math.max(...nums) }
    }
    if (Object.keys(totals).length) out.totals = totals
    const byStatus: NonNullable<ModuleDigest['byStatus']> = {}
    for (const f of fields.filter((x) => x.type === 'dropdown' || x.type === 'radio').slice(0, 3)) {
      const counts: Record<string, number> = {}
      for (const r of rows) {
        const label = displayValue(f, valueOf(m, r, f, ctx), ctx) || '(empty)'
        counts[label] = (counts[label] ?? 0) + 1
      }
      byStatus[f.label] = counts
    }
    if (Object.keys(byStatus).length) out.byStatus = byStatus
    out.newest = [...rows]
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
      .slice(0, MAX_SAMPLES)
      .map((r) => {
        const row: Record<string, string> = { title: recordTitle(m, r, ctx) }
        for (const f of fields.slice(0, MAX_FIELDS)) {
          const v = displayValue(f, valueOf(m, r, f, ctx), ctx)
          if (v) row[f.label] = String(v).slice(0, 60)
        }
        return row
      })
    return out
  })
}
