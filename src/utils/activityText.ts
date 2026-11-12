import type { StepEvent } from '#/genius/service/run'

/**
 * The ONE place where the pipeline's internal progress and status strings are turned into the words people read.
 * Nothing in the Studio UI shows a raw step label: it goes through `activityPhrase` / `friendlyStatus` first.
 */

const PHRASE: Record<string, string> = {
  understand: 'Understanding your request...',
  clarify: 'Checking the details...',
  context: 'Arranging your modules...',
  find: 'Looking at the related CRM area...',
  handle: 'Looking at the related CRM area...',
  design: 'Preparing the changes...',
  build: 'Preparing the changes...',
  validate: 'Verifying the changes...',
  preview: 'Preparing the preview...',
  prepare: 'Preparing the preview...',
  repair: 'A few details need fixing',
  apply: 'Applying the changes...',
  verify: 'Verifying the changes...',
  summary: 'Preparing the summary...',
}

/** pipeline steps that are bookkeeping rather than a stage worth showing (model choice and the like) */
const HIDDEN = new Set(['route'])

export const STATUS_DONE_APPLIED = 'Changes completed successfully'
export const STATUS_DONE_PLAIN = 'All done'
export const STATUS_DONE_READY = 'Changes are ready'
export const STATUS_FIX_NEEDED = 'A few details need fixing'
export const STATUS_STOPPED = 'Stopped'

export interface ActivityLine {
  key: string
  text: string
  status: StepEvent['status']
}

/** The natural phrase for one real pipeline step, or null when the step is not worth showing. */
export function activityPhrase(step: Pick<StepEvent, 'id' | 'status'>): string | null {
  if (HIDDEN.has(step.id) || step.status === 'skipped') return null
  return PHRASE[step.id] ?? null
}

/** Real steps -> visible lines: relevant stages only, and the same wording is never listed twice in a row. */
export function activityLines(steps: StepEvent[]): ActivityLine[] {
  const out: ActivityLine[] = []
  for (const s of steps) {
    const text = activityPhrase(s)
    if (!text) continue
    const prev = out[out.length - 1]
    if (prev && prev.text === text) {
      out[out.length - 1] = { ...prev, status: s.status === 'running' && prev.status !== 'running' ? prev.status : s.status }
      continue
    }
    // a stage that came back round (a second pass) updates its first line instead of repeating it
    const again = out.findIndex((l) => l.text === text)
    if (again >= 0) {
      out[again] = { ...out[again], status: s.status }
      continue
    }
    out.push({ key: `${s.id}-${out.length}`, text, status: s.status })
  }
  return out
}

/** The compact status shown while the dropdown is closed: the stage that is running now, else the last one that finished. */
export function currentActivity(steps: StepEvent[]): string {
  const lines = activityLines(steps)
  const running = [...lines].reverse().find((l) => l.status === 'running')
  return (running ?? lines[lines.length - 1])?.text ?? PHRASE.understand
}

const REPLACE: [RegExp, string][] = [
  [/\bReading (your )?request\b/gi, 'Understanding your request'],
  [/\bOrganizing modules\b/gi, 'Arranging your modules'],
  [/\bChoosing how to (build|do this)\b/gi, 'Deciding the best approach'],
  [/\bRequest is ambiguous\b/gi, 'A few details need fixing'],
  [/\bLarge model\b/gi, 'Detailed approach'],
  [/\bFast model\b/gi, 'Quick approach'],
  [/\bAPI operation\b/gi, 'action'],
  [/\bmutations?\b/gi, 'changes'],
  [/\bschema\b/gi, 'structure'],
  [/\btokens?\b/gi, 'words'],
]

/** Any other internal string that could reach the screen (a step label, a status, a pipeline message). */
export function friendlyStatus(raw: string): string {
  let s = raw
  for (const [re, to] of REPLACE) s = s.replace(re, to)
  return s
}

// ---- the preview panel's contextual line ------------------------------------------------------------------------------

/** One short line for the preview while it works, chosen from what is actually being done. */
export function previewLine(request: string, steps: StepEvent[]): string {
  const finishing = steps.some((s) => (s.id === 'validate' || s.id === 'preview' || s.id === 'prepare') && s.status === 'running')
  if (finishing) return 'Finalizing your design...'
  const t = request.toLowerCase()
  if (/\bform(s)?\b/.test(t)) return 'Creating your form...'
  if (/dashboard|card|widget/.test(t)) return 'Building your dashboard...'
  if (/analytic|chart|graph|report|kpi/.test(t)) return 'Preparing analytics...'
  if (/connect|import|sync|data flow|integrat/.test(t)) return 'Connecting your data...'
  if (/\b(update|change|edit|rename|modify|add|remove|move|delete)\b/.test(t)) return 'Updating your workspace...'
  return 'Generating...'
}
