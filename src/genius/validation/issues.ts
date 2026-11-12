export type Stage = 'schema' | 'references' | 'business' | 'cycles' | 'security' | 'sandbox'
export const STAGE_ORDER: Stage[] = ['schema', 'references', 'business', 'cycles', 'security', 'sandbox']

/** Structured validation error: stable code, component path, description, severity, repair guidance. */
export interface Issue {
  code: string
  path: string
  message: string
  severity: 'error' | 'warning'
  repair: string
  stage: Stage
  /** the request asked for something this app cannot execute; the component is left out and reported */
  notImplementable?: boolean
  /** root-cause category, for the UI and the repair step */
  category?: 'enum' | 'type' | 'missing' | 'format' | 'unknown_key' | 'size' | 'other'
  /** enum values the field accepts */
  allowed?: string[]
  /** what the model actually wrote (shortened) */
  received?: unknown
  /** a safe, meaning-preserving replacement when one is known */
  suggested?: unknown
  /** set after a repair step: did an automatic repair clear this error? */
  autoRepaired?: boolean
  /** false when only the user can resolve it */
  userActionRequired?: boolean
}

export const issue = (stage: Stage, code: string, path: string, message: string, repair: string, severity: Issue['severity'] = 'error'): Issue => ({ stage, code, path, message, repair, severity })

export interface ValidationReport {
  ok: boolean
  errors: Issue[]
  warnings: Issue[]
  notImplementable: Issue[]
  stagesRun: Stage[]
  sandbox?: { ran: boolean; syntheticRecords: number; limitations: string[] }
}

export function report(issues: Issue[], stagesRun: Stage[], sandbox?: ValidationReport['sandbox']): ValidationReport {
  const notImplementable = issues.filter((i) => i.notImplementable)
  const rest = issues.filter((i) => !i.notImplementable)
  const errors = rest.filter((i) => i.severity === 'error')
  return { ok: errors.length === 0, errors, warnings: rest.filter((i) => i.severity === 'warning'), notImplementable, stagesRun, sandbox }
}

/** Stable signature of a set of errors: used to detect a repair that did not change anything. */
export function errorSignature(errors: Issue[]): string {
  return errors
    .map((e) => `${e.code}@${e.path}`)
    .sort()
    .join('|')
}
