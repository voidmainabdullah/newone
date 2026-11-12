import { describe, expect, it } from 'vitest'
import { repairRelationships } from '#/genius/ai/relation-logic'
import { parseEnvelope } from '#/genius/ai/generate'

const mod = (id: string, singular: string, plural: string, kind = 'entity', fields: any[] = [{ id: 'name', label: 'Name', type: 'shortText' }]) => ({ id, singular, plural, kind, fields })
const rel = (id: string, source: string, target: string, extra: any = {}) => ({ id, label: id, sourceModuleId: source, targetModuleId: target, cardinality: 'many-to-one', deletePolicy: 'restrict', ...extra })

describe('data flow repair (child stores the link to its parent)', () => {
  it('turns parent-to-child links around, using the business chain', () => {
    const bp: any = {
      modules: [mod('hostel', 'Hostel', 'Hostels'), mod('room', 'Room', 'Rooms'), mod('booking', 'Booking', 'Bookings'), mod('payment', 'Payment', 'Payments', 'ledger')],
      relationships: [rel('hostel_room', 'hostel', 'room'), rel('room_booking', 'room', 'booking'), rel('booking_payment', 'booking', 'payment')],
    }
    const notes = repairRelationships(bp)
    const pairs = bp.relationships.map((r: any) => `${r.sourceModuleId}>${r.targetModuleId}`).sort()
    expect(pairs).toEqual(['booking>room', 'payment>booking', 'room>hostel'])
    expect(notes.length).toBe(3)
  })

  it('leaves a correct chain alone and normalises one-to-many', () => {
    const bp: any = { modules: [mod('room', 'Room', 'Rooms'), mod('booking', 'Booking', 'Bookings')], relationships: [rel('booking_room', 'booking', 'room')] }
    expect(repairRelationships(bp)).toEqual([])
    const two: any = { modules: [mod('room', 'Room', 'Rooms'), mod('unit_x', 'Gadget', 'Gadgets')], relationships: [rel('r', 'room', 'unit_x', { cardinality: 'one-to-many' })] }
    repairRelationships(two)
    expect(two.relationships[0]).toMatchObject({ sourceModuleId: 'unit_x', targetModuleId: 'room', cardinality: 'many-to-one' })
  })

  it('removes a text field that repeats the link, and breaks loops', () => {
    const bp: any = {
      modules: [mod('room', 'Room', 'Rooms'), mod('booking', 'Booking', 'Bookings', 'entity', [{ id: 'ref', label: 'Reference', type: 'shortText' }, { id: 'room', label: 'Room', type: 'shortText' }, { id: 'booking_room', label: 'Room', type: 'relationship' }])],
      relationships: [rel('booking_room', 'booking', 'room'), rel('loop', 'room', 'booking')],
    }
    const notes = repairRelationships(bp)
    expect(bp.modules[1].fields.map((f: any) => f.id)).toEqual(['ref', 'booking_room'])
    expect(bp.relationships).toHaveLength(1)
    expect(notes.join(' ')).toMatch(/repeated the link/)
    expect(notes.join(' ')).toMatch(/second link|loop/)
  })

  it('reports the corrections as assumptions when a blueprint is parsed', () => {
    const env = parseEnvelope('blueprint', {
      status: 'ok', summary: 's', assumptions: ['Amounts use USD.'], questions: [],
      blueprint: {
        meta: { name: 'n', domain: 'd', locale: 'en', currency: 'USD', timezone: 'UTC', blueprintVersion: '1', schemaVersion: 1, projectId: 'p', revisionId: 'r' },
        modules: [mod('room', 'Room', 'Rooms'), mod('booking', 'Booking', 'Bookings')],
        relationships: [rel('room_booking', 'room', 'booking')],
        forms: [], layouts: [], views: [], pipelines: [], workflows: [], formulas: [], dashboards: [], roles: [], permissions: [],
      },
    })
    expect((env.blueprint as any).relationships[0]).toMatchObject({ sourceModuleId: 'booking', targetModuleId: 'room' })
    expect(env.assumptions?.some((a) => /turned around/.test(a))).toBe(true)
  })
})
