import { BarChart3, Boxes, Contact, FileText, FormInput, LayoutDashboard, ListChecks, MoreHorizontal, Rows3, Workflow, type LucideIcon } from 'lucide-react'

export type LandingMode = 'ask' | 'build' | 'dashboard' | 'data'

export const MODES: { id: LandingMode; label: string; placeholder: string }[] = [
  { id: 'ask', label: 'Ask', placeholder: 'Need help? Ask, search, or create.' },
  { id: 'build', label: 'Build', placeholder: 'Describe the CRM, module or form you want built.' },
  { id: 'dashboard', label: 'Dashboard', placeholder: 'Describe the dashboard or chart you want to see.' },
  { id: 'data', label: 'Data', placeholder: 'Add, update or find records, for example "Add contact Sara Khan, sara@example.com".' },
]

/** Four example prompts per mode, shown under "Suggestions". Clicking one fills the message box. */
export const SUGGESTIONS: Record<LandingMode, string[]> = {
  ask: [
    'How many contacts do I have?',
    'Which deals are still open this month?',
    'Show me everything that is overdue',
    'Explain how my dashboard totals are calculated',
  ],
  build: [
    'Build a sales CRM with contacts, companies, deals and follow-ups',
    'Build a CRM for a school academy with students, guardians, classes and fees',
    'Create a contact form that adds new leads to Contacts',
    'Add a City field to Contacts',
  ],
  dashboard: [
    'Create a sales dashboard with total revenue, monthly orders and pending payments',
    'Add a bar chart of deals by stage',
    'Show total contacts as a number card',
    'Make a dashboard for my support tickets',
  ],
  data: [
    'Add a contact called Sara Khan with the email sara@example.com',
    'Mark all overdue tasks as high priority',
    'Move the Acme deal to the Negotiation stage',
    'Find duplicate contacts and list them',
  ],
}

export interface DockTile {
  id: string
  label: string
  icon: LucideIcon
  /** tile colour (a solid, saturated colour that works on both themes) */
  color: string
  mode: LandingMode
  prompt: string
}

export const DOCK: { heading: string; tiles: DockTile[] }[] = [
  {
    heading: 'Collaborate',
    tiles: [
      { id: 'contacts', label: 'Contacts', icon: Contact, color: '#3b82f6', mode: 'build', prompt: 'Create a Contacts module with name, email, phone, company and status' },
      { id: 'tasks', label: 'Tasks', icon: ListChecks, color: '#10b981', mode: 'build', prompt: 'Create a Tasks module with title, due date, owner, priority and status' },
    ],
  },
  {
    heading: 'Organize',
    tiles: [
      { id: 'modules', label: 'Modules', icon: Boxes, color: '#8b5cf6', mode: 'build', prompt: 'Build a CRM with modules for contacts, companies and deals, linked together' },
      { id: 'fields', label: 'Fields', icon: Rows3, color: '#f59e0b', mode: 'build', prompt: 'Add a City field and a Lead source dropdown to Contacts' },
      { id: 'forms', label: 'Forms', icon: FormInput, color: '#ec4899', mode: 'build', prompt: 'Create a contact form that adds new leads to Contacts' },
    ],
  },
  {
    heading: 'Create',
    tiles: [
      { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, color: '#6366f1', mode: 'dashboard', prompt: 'Create a sales dashboard with total revenue, monthly orders and pending payments' },
      { id: 'chart', label: 'Chart', icon: BarChart3, color: '#0ea5e9', mode: 'dashboard', prompt: 'Add a bar chart of deals by stage to my dashboard' },
      { id: 'workflow', label: 'Workflow', icon: Workflow, color: '#f97316', mode: 'build', prompt: 'When a deal is marked Won, create a follow-up task for the owner' },
      { id: 'report', label: 'Report', icon: FileText, color: '#14b8a6', mode: 'ask', prompt: 'Show a summary report of deals won and lost this month' },
    ],
  },
]

export const MORE_TILE = { id: 'more', label: 'More', icon: MoreHorizontal, color: '#64748b' }
