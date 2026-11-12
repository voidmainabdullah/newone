/**
 * Capability registry: one entry per thing Studio can do (or knows it cannot do yet). The planner may only choose from this list,
 * and a request that needs something marked "unsupported" is answered honestly instead of invented.
 * Every patch operation must appear in `ops`; a test fails when a new operation is added without being registered here.
 */
export type CapabilityStatus = 'supported' | 'read_only' | 'unsupported'

export interface Capability {
  id: string
  domain: 'workspace' | 'schema' | 'data_flow' | 'ui' | 'automation' | 'analytics' | 'security' | 'search' | 'records'
  title: string
  description: string
  status: CapabilityStatus
  /** the typed operations (patch ops, or the named engine) that implement it */
  ops: string[]
  /** needs the user to press Apply (writes configuration) */
  writesConfig: boolean
  /** the permission the signed-in user needs */
  permission: string
  /** can be applied twice without a second effect */
  idempotent: boolean
  /** what the user must still do or know */
  note?: string
}

export const CAPABILITIES: Capability[] = [
  { id: 'workspace.create', domain: 'workspace', title: 'New project in its own empty workspace', description: 'A new CRM build always opens in a fresh empty workspace; other workspaces are untouched.', status: 'supported', ops: ['blueprint'], writesConfig: true, permission: 'manageFields', idempotent: true },
  { id: 'schema.module', domain: 'schema', title: 'Modules', description: 'Create, rename and archive modules (All Modules / Module Builder).', status: 'supported', ops: ['add_module', 'update_module', 'remove_module'], writesConfig: true, permission: 'manageFields', idempotent: true, note: 'Modules that hold records are archived, never deleted.' },
  { id: 'schema.field', domain: 'schema', title: 'Fields', description: 'Add, change and remove fields, required/unique rules, options (Field Manager).', status: 'supported', ops: ['add_field', 'update_field', 'remove_field'], writesConfig: true, permission: 'manageFields', idempotent: true },
  { id: 'data_flow.relationship', domain: 'data_flow', title: 'Relationships (data flow)', description: 'Parent/child links stored on the child, with cardinality and delete rules.', status: 'supported', ops: ['add_relationship', 'update_relationship'], writesConfig: true, permission: 'manageFields', idempotent: true },
  { id: 'data_flow.event_rules', domain: 'data_flow', title: 'Data Flow page rules', description: 'Rules on the Data Flow page that copy or update records when something happens.', status: 'unsupported', ops: [], writesConfig: false, permission: 'manageWorkflows', idempotent: false, note: 'Build it by hand on the Data Flow page, or use a workflow for the same effect.' },
  { id: 'schema.pipeline', domain: 'schema', title: 'Pipelines / stages', description: 'Status stages on a module and the allowed moves.', status: 'supported', ops: ['add_pipeline', 'update_pipeline'], writesConfig: true, permission: 'manageFields', idempotent: true },
  { id: 'schema.formula', domain: 'schema', title: 'Calculations', description: 'Exact decimal formulas, with test cases.', status: 'supported', ops: ['add_formula', 'update_formula'], writesConfig: true, permission: 'manageFields', idempotent: true },
  { id: 'ui.form', domain: 'ui', title: 'Forms', description: 'Record forms and their sections (Form Builder).', status: 'supported', ops: ['add_form', 'update_form'], writesConfig: true, permission: 'manageForms', idempotent: true },
  { id: 'ui.view', domain: 'ui', title: 'Views', description: 'Table, kanban, calendar and other views with filters and sorting (View Builder).', status: 'supported', ops: ['add_view', 'update_view'], writesConfig: true, permission: 'manageFields', idempotent: true },
  { id: 'automation.workflow', domain: 'automation', title: 'Workflows', description: 'Trigger, conditions and in-app actions (update, create record, task, notify). New workflows start switched off until approved after a dry run.', status: 'supported', ops: ['add_workflow', 'update_workflow', 'enable_workflow', 'disable_workflow'], writesConfig: true, permission: 'manageWorkflows', idempotent: true, note: 'Runs only while the app is open; no email, SMS or outside calls.' },
  { id: 'automation.graph', domain: 'automation', title: 'Branching workflow graph', description: 'True/false branches, parallel paths, waits, retries and background execution.', status: 'unsupported', ops: [], writesConfig: false, permission: 'manageWorkflows', idempotent: false, note: 'Workflows are one trigger, conditions and a list of actions. Use two workflows for two outcomes.' },
  { id: 'analytics.dashboard', domain: 'analytics', title: 'Dashboards and Overview analytics', description: 'Dashboard widgets; every module also gets automatic analytics on the Overview.', status: 'supported', ops: ['add_dashboard', 'update_dashboard'], writesConfig: true, permission: 'manageDashboards', idempotent: true },
  { id: 'security.role', domain: 'security', title: 'Roles and permissions', description: 'Roles with least-privilege grants, per-module and per-field access.', status: 'supported', ops: ['add_role', 'update_permissions'], writesConfig: true, permission: 'manageFields', idempotent: true, note: 'Never grants access to settings.' },
  { id: 'search.query', domain: 'search', title: 'Search (typed QuerySpec)', description: 'Search page and “Ask in plain words”: text, exact filters, linked-record conditions, sorting and totals, all run locally with permissions.', status: 'supported', ops: ['queryspec'], writesConfig: false, permission: 'viewModules', idempotent: true },
  { id: 'search.config', domain: 'search', title: 'AI-built search pages (saved SearchConfig)', description: 'A named, shareable search page with chosen facets and layout, created by prompt.', status: 'unsupported', ops: [], writesConfig: false, permission: 'manageFields', idempotent: false, note: 'Searches can be saved per workspace on the Search page; they are not yet pages in the navigation.' },
  { id: 'search.semantic', domain: 'search', title: 'Meaning-based (vector) search', description: 'Embeddings over long text.', status: 'unsupported', ops: [], writesConfig: false, permission: 'viewModules', idempotent: true, note: 'Search uses exact filters and ranked word matching.' },
  { id: 'records.read', domain: 'records', title: 'Read records', description: 'Counts, totals, status splits and the newest records, only what the user may see.', status: 'read_only', ops: ['record_digest'], writesConfig: false, permission: 'viewModules', idempotent: true },
  { id: 'records.write', domain: 'records', title: 'Create, update and delete records by prompt', description: 'Changing records from a chat request.', status: 'unsupported', ops: [], writesConfig: false, permission: 'editRecords', idempotent: false, note: 'Edit records in the module screens or import them; Studio only reads them.' },
]

/** Every patch operation the schema defines must be registered above. */
export const REGISTERED_OPS = new Set(CAPABILITIES.flatMap((c) => c.ops))

export const unsupportedCapabilities = () => CAPABILITIES.filter((c) => c.status === 'unsupported')

/** One short paragraph for prompts: what exists, and what must be refused or left out and disclosed. */
export function capabilityDigest(): string {
  const yes = CAPABILITIES.filter((c) => c.status !== 'unsupported').map((c) => c.title).join('; ')
  const no = unsupportedCapabilities().map((c) => c.title).join('; ')
  return `WHAT GENIUS CAN DO: ${yes}. NOT AVAILABLE YET (say so plainly, leave it out, and suggest the closest supported option): ${no}.`
}
