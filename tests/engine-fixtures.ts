import type { CrmRecord, Field, Module } from '#/types'
import { useModuleStore } from '#/stores/moduleStore'
import { useRecordStore } from '#/stores/recordStore'
import { makeEnv } from '#/engine/resolve'
import { WS } from './helpers'

const T = '2026-01-01T00:00:00.000Z'

export const field = (id: string, type: Field['type'], extra: Partial<Field> = {}): Field => ({ id, name: id, label: id.replace(/_/g, ' '), type, width: 'half', order: 0, visible: true, ...extra }) as Field

export const mod = (id: string, name: string, fields: Field[], extra: Partial<Module> = {}): Module =>
  ({ id, workspaceId: WS, name, icon: 'Box', color: '#000', fields: fields.map((f, i) => ({ ...f, order: i })), visible: true, archived: false, order: 0, createdAt: T, updatedAt: T, ...extra }) as Module

export const rec = (moduleId: string, id: string, data: Record<string, unknown>, extra: Partial<CrmRecord> = {}): CrmRecord => ({ id, workspaceId: WS, moduleId, data, createdAt: T, updatedAt: T, ...extra })

/** Fees: total / paid / remaining (calculated) / payment status */
export const feesModule = (over: { calculatedRemaining?: boolean } = {}): Module =>
  mod('mod_fees', 'Fees', [
    field('total_amount', 'currency'),
    field('paid_amount', 'currency'),
    field('remaining_amount', 'currency', over.calculatedRemaining === false ? {} : { calculated: true, readOnly: true }),
    field('payment_status', 'dropdown', { options: [{ id: 'paid', label: 'Paid' }, { id: 'partial', label: 'Partial' }, { id: 'pending', label: 'Pending' }] }),
    field('due_date', 'date'),
    field('notes', 'shortText'),
  ])

export const studentsModule = (): Module => mod('mod_students', 'Students', [field('full_name', 'shortText'), field('total_paid', 'currency', { calculated: true, readOnly: true }), field('payment_count', 'number', { calculated: true, readOnly: true })], { order: 0 })
export const paymentsModule = (): Module =>
  mod('mod_payments', 'Payments', [field('student', 'relationship', { relation: { moduleId: 'mod_students', cardinality: 'many-to-one' } }), field('amount', 'currency'), field('paid_on', 'date'), field('method', 'dropdown', { options: [{ id: 'cash', label: 'Cash' }, { id: 'card', label: 'Card' }] })], { order: 1 })

export const putModules = (...mods: Module[]) => useModuleStore.getState().setAll(mods)
export const envOf = (modules: Module[], records: CrmRecord[], now = new Date('2026-03-15T10:00:00')) => makeEnv(modules, records, now)
export const recordsOf = (moduleId: string) => useRecordStore.getState().records.filter((r) => r.moduleId === moduleId)
export const dataOf = (id: string) => useRecordStore.getState().records.find((r) => r.id === id)!.data
