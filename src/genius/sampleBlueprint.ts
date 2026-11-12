import type { Blueprint } from './blueprint/schema'

/**
 * A small, hand-written hostel CRM used ONLY by the public /genius-preview page to show the Studio layout and the CRM
 * preview without signing in or calling a model. It is not parsed by the validator and never written to a workspace.
 */
const m = (id: string, singular: string, plural: string, kind: string, icon: string, color: string, group: string, fields: [string, string, string][]) => ({ id, singular, plural, kind, icon, color, navigation: { group }, fields: fields.map(([fid, label, type]) => ({ id: fid, label, type })) })

export const SAMPLE_BLUEPRINT = {
  meta: { name: 'Hostel manager', domain: 'hospitality', locale: 'en-GB', currency: 'GBP', timezone: 'UTC', blueprintVersion: '1', schemaVersion: 1, projectId: 'sample', revisionId: 'sample' },
  modules: [
    m('hostels', 'Hostel', 'Hostels', 'entity', 'Building2', '#4285F4', 'Property', [['name', 'Name', 'shortText'], ['city', 'City', 'shortText'], ['capacity', 'Capacity', 'number']]),
    m('rooms', 'Room', 'Rooms', 'entity', 'Home', '#34A853', 'Property', [['number', 'Room number', 'shortText'], ['beds', 'Beds', 'number'], ['status', 'Status', 'dropdown'], ['rate', 'Monthly rate', 'currency']]),
    m('residents', 'Resident', 'Residents', 'entity', 'Users', '#9B72CB', 'People', [['full_name', 'Full name', 'shortText'], ['email', 'Email', 'email'], ['phone', 'Phone', 'phone']]),
    m('bookings', 'Booking', 'Bookings', 'transaction', 'CalendarCheck', '#F9AB00', 'Operations', [['ref', 'Reference', 'shortText'], ['check_in', 'Check-in', 'date'], ['check_out', 'Check-out', 'date'], ['status', 'Status', 'dropdown']]),
    m('payments', 'Payment', 'Payments', 'ledger', 'Wallet', '#D96570', 'Operations', [['amount', 'Amount', 'currency'], ['paid_on', 'Paid on', 'date'], ['method', 'Method', 'dropdown']]),
  ],
  relationships: [
    { id: 'room_hostel', label: 'Hostel', sourceModuleId: 'rooms', targetModuleId: 'hostels', cardinality: 'many-to-one', required: true, deletePolicy: 'restrict' },
    { id: 'booking_room', label: 'Room', sourceModuleId: 'bookings', targetModuleId: 'rooms', cardinality: 'many-to-one', required: true, deletePolicy: 'restrict' },
    { id: 'booking_resident', label: 'Resident', sourceModuleId: 'bookings', targetModuleId: 'residents', cardinality: 'many-to-one', required: true, deletePolicy: 'restrict' },
    { id: 'payment_booking', label: 'Booking', sourceModuleId: 'payments', targetModuleId: 'bookings', cardinality: 'many-to-one', required: true, deletePolicy: 'restrict' },
  ],
  forms: [], layouts: [], views: [],
  pipelines: [{ id: 'booking_stage', moduleId: 'bookings', stages: [{ id: 'pending', label: 'Pending', color: '#F9AB00' }, { id: 'confirmed', label: 'Confirmed', color: '#4285F4' }, { id: 'checked_in', label: 'Checked in', color: '#34A853' }, { id: 'checked_out', label: 'Checked out', color: '#9AA0A6' }] }],
  workflows: [], formulas: [], permissions: [], roles: [],
  dashboards: [{ id: 'overview', name: 'Overview', components: [
    { id: 'w1', title: 'Rooms', type: 'stat', moduleId: 'rooms', agg: 'count', dateRange: 'all', filters: [], w: 1, h: 1, definition: 'Number of rooms across all hostels', refresh: 'live' },
    { id: 'w2', title: 'Active bookings', type: 'stat', moduleId: 'bookings', agg: 'count', dateRange: 'all', filters: [], w: 1, h: 1, definition: 'Bookings that are confirmed or checked in', refresh: 'live' },
    { id: 'w3', title: 'Payments this month', type: 'stat', moduleId: 'payments', agg: 'sum', dateRange: '30d', filters: [], w: 1, h: 1, definition: 'Sum of payments received in the last 30 days', refresh: 'live' },
    { id: 'w4', title: 'Bookings by stage', type: 'pipeline', moduleId: 'bookings', agg: 'count', dateRange: 'all', filters: [], w: 2, h: 2, definition: 'How many bookings sit in each stage', refresh: 'live' },
  ] }],
} as unknown as Blueprint
