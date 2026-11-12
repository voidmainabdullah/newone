import type { Field, FieldAccess } from '#/types'
import { sameValue } from '#/engine/calc'

/**
 * The rules behind inline field controls, kept free of React so they are unit-tested.
 *
 *  - which control a field gets (`controlFor`): never a toggle for more than two states;
 *  - whether the person may change it at all (`editableState`);
 *  - what needs a confirmation (`confirmMessage`);
 *  - how a typed value is read (`parseInlineValue`);
 *  - the save itself, optimistic with a rollback and an error message (`commitInline`).
 */

export type Control = 'toggle' | 'select' | 'segmented' | 'date' | 'number' | 'text' | 'readonly'
export type Surface = 'table' | 'card' | 'drawer'

/** values the engine, a formula or the system owns: nobody types into them */
export const isLockedField = (f: Field): boolean => !!f.calculated || !!f.readOnly || f.type === 'formula' || f.type === 'autoId'

const CHOICE = new Set<Field['type']>(['dropdown', 'radio'])
const NUMBERS = new Set<Field['type']>(['number', 'currency', 'percentage'])

/**
 * Which control a field gets.
 *  - yes/no -> toggle
 *  - a choice with exactly 2 options -> toggle (first = off, second = on)
 *  - a choice with 3 or more options -> dropdown, or a segmented control in the drawer when there are 4 or fewer
 *  - date / date-time -> date picker; number / currency / percentage -> number input
 *  - calculated, formula, auto id, read-only -> 'readonly'
 *  - anything else -> 'text': shown as plain value, edited through the full form
 */
export function controlFor(field: Field, surface: Surface = 'table'): Control {
  if (isLockedField(field)) return 'readonly'
  if (field.type === 'yesNo') return 'toggle'
  if (CHOICE.has(field.type)) {
    const n = field.options?.length ?? 0
    if (n === 2) return 'toggle'
    if (n >= 3 && n <= 4 && surface === 'drawer') return 'segmented'
    return 'select'
  }
  if (field.type === 'date' || field.type === 'datetime') return 'date'
  if (NUMBERS.has(field.type)) return 'number'
  return 'text'
}

/** the two values a toggle switches between, and what to call them */
export function toggleValues(field: Field): { off: unknown; on: unknown; offLabel: string; onLabel: string } {
  if (field.type === 'yesNo') return { off: false, on: true, offLabel: 'No', onLabel: 'Yes' }
  const [a, b] = field.options ?? []
  return { off: a?.id ?? '', on: b?.id ?? '', offLabel: a?.label ?? '', onLabel: b?.label ?? '' }
}

export interface EditContext {
  canEditModule: boolean
  access: FieldAccess
  trashed?: boolean
  archived?: boolean
}

export type EditableState = { editable: true } | { editable: false; reason: string }

/** may this person change this field of this record inline? (the reason becomes the tooltip) */
export function editableState(field: Field, c: EditContext): EditableState {
  if (field.calculated) return { editable: false, reason: 'Calculated automatically' }
  if (field.type === 'formula') return { editable: false, reason: 'Calculated from a formula' }
  if (field.type === 'autoId') return { editable: false, reason: 'Generated automatically' }
  if (field.readOnly) return { editable: false, reason: 'This field is read-only' }
  if (c.trashed) return { editable: false, reason: 'This record is in the trash' }
  if (!c.canEditModule || c.access !== 'edit') return { editable: false, reason: 'Your role cannot edit this field' }
  return { editable: true }
}

/** the question to ask before this change is saved, or null when it needs no confirmation */
export function confirmMessage(field: Field, next: unknown): string | null {
  const optionLabel = field.options?.find((o) => o.id === next)?.label
  if (field.sensitive) return `“${field.label}” is marked as sensitive. Change it to ${optionLabel ?? (next === '' || next === null || next === undefined ? 'empty' : String(next))}?`
  if (typeof next === 'string' && field.sensitiveOptions?.includes(next)) return `Set “${field.label}” to ${optionLabel ?? next}? This is a sensitive change.`
  return null
}

export type ParsedInline = { ok: true; value: number | '' } | { ok: false; error: string }

/** read what was typed into an inline number box; blank clears the value */
export function parseInlineValue(field: Field, raw: string): ParsedInline {
  const t = raw.trim().replace(/,/g, '')
  if (t === '') return { ok: true, value: '' }
  const n = Number(t)
  if (!Number.isFinite(n)) return { ok: false, error: `“${raw}” is not a number` }
  if (field.min !== undefined && n < field.min) return { ok: false, error: `${field.label} must be at least ${field.min}` }
  if (field.max !== undefined && n > field.max) return { ok: false, error: `${field.label} must be at most ${field.max}` }
  return { ok: true, value: n }
}

export interface CommitDeps {
  /** the record store's update (validated); returns null when the record is gone */
  write: (recordId: string, patch: Record<string, unknown>) => { record?: unknown; errors?: Record<string, string> } | null
  confirm: (o: { title: string; message?: string; confirmLabel?: string; danger?: boolean }) => Promise<boolean>
  onError: (title: string, message: string) => void
}

export type CommitResult = { status: 'saved' } | { status: 'unchanged' } | { status: 'cancelled' } | { status: 'error'; message: string }

/**
 * Save one field. The caller shows the new value straight away (optimistic) and rolls back unless this returns 'saved' or
 * 'unchanged'. A refused or failing write never leaves a half change behind: when the write throws, the previous value is
 * written back before the error is reported.
 */
export async function commitInline(args: { recordId: string; field: Field; prev: unknown; next: unknown; deps: CommitDeps }): Promise<CommitResult> {
  const { recordId, field, prev, next, deps } = args
  if (sameValue(prev, next)) return { status: 'unchanged' }
  const q = confirmMessage(field, next)
  if (q && !(await deps.confirm({ title: 'Confirm change', message: q, confirmLabel: 'Change', danger: false }))) return { status: 'cancelled' }
  const fail = (message: string): CommitResult => {
    deps.onError(`Could not save ${field.label}`, message)
    return { status: 'error', message }
  }
  let res: ReturnType<CommitDeps['write']>
  try {
    res = deps.write(recordId, { [field.id]: next })
  } catch (e) {
    try {
      deps.write(recordId, { [field.id]: prev })
    } catch {
      /* the original failure is what the person needs to hear about */
    }
    return fail(e instanceof Error ? e.message : 'The change could not be written')
  }
  if (!res) return fail('This record no longer exists')
  if (res.errors) return fail(Object.values(res.errors)[0] ?? 'The value is not valid')
  return { status: 'saved' }
}
