import type { Module } from '#/types'
import { expect } from 'vitest'
import { parseNl, type NlDraft, type NlResult } from '#/engine/nl'
import { validationEnvFor } from '#/engine/service'
import { validateConfig } from '#/engine/validate'
import { field, mod, rec } from './engine-fixtures'
import { WS } from './helpers'

/** A small school CRM: students with attendance, fees with a calculated balance and a status, payments. */
export const schoolModules = (): Module[] => [
  mod('mod_students', 'Students', [field('full_name', 'shortText'), field('grade', 'dropdown', { options: [{ id: 'y9', label: 'Year 9' }, { id: 'y10', label: 'Year 10' }, { id: 'y11', label: 'Year 11' }] }), field('attendance', 'number', { label: 'Attendance' })], { order: 0, singularName: 'Student' }),
  mod(
    'mod_fees',
    'Fees',
    [
      field('student', 'relationship', { relation: { moduleId: 'mod_students', cardinality: 'many-to-one' } }),
      field('total_amount', 'currency', { currency: 'GBP' }),
      field('paid_amount', 'currency', { currency: 'GBP' }),
      field('remaining_amount', 'currency', { currency: 'GBP', calculated: true, readOnly: true }),
      field('payment_status', 'dropdown', { options: [{ id: 'paid', label: 'Paid' }, { id: 'partial', label: 'Partial' }, { id: 'pending', label: 'Pending' }] }),
      field('due_date', 'date'),
      field('notes', 'shortText'),
    ],
    { order: 1, singularName: 'Fee' },
  ),
  mod('mod_payments', 'Payments', [field('pay_amount', 'currency', { currency: 'GBP' }), field('paid_on', 'date'), field('method', 'dropdown', { options: [{ id: 'cash', label: 'Cash' }, { id: 'card', label: 'Card' }] })], { order: 2, singularName: 'Payment' }),
]

export const schoolRecords = () => [
  rec('mod_students', 'st1', { full_name: 'Ada', grade: 'y9', attendance: 90 }),
  rec('mod_students', 'st2', { full_name: 'Ben', grade: 'y9', attendance: 70 }),
  rec('mod_students', 'st3', { full_name: 'Cy', grade: 'y10', attendance: 60 }),
  rec('mod_students', 'st4', { full_name: 'Di', grade: 'y11', attendance: 80 }),
  rec('mod_fees', 'f1', { student: 'st1', total_amount: 1000, paid_amount: 1000, payment_status: 'paid' }),
  rec('mod_fees', 'f2', { student: 'st2', total_amount: 1000, paid_amount: 400, payment_status: 'partial' }),
  rec('mod_fees', 'f3', { student: 'st3', total_amount: 500, paid_amount: 0, payment_status: 'pending' }),
  rec('mod_fees', 'f4', { student: 'st4', total_amount: 800, paid_amount: '', payment_status: 'pending' }),
]

/** Parse, require a draft, and require that it passes the real validator (fields exist, operators fit, no cycles). */
export function draftOf(request: string, modules: Module[], answers?: Record<string, string>): NlDraft {
  const res: NlResult = parseNl(request, modules, { answers })
  if (res.kind !== 'draft') throw new Error(`expected a draft for "${request}", got ${JSON.stringify(res)}`)
  const v = validateConfig(res.body, validationEnvFor(WS, { role: null }))
  expect(v.errors, `validation of "${request}"`).toEqual([])
  expect(v.ok).toBe(true)
  return res
}
