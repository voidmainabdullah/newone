/**
 * Icons the CRM can draw (a subset of the app's icon set, picked for business modules) and a keyword guess used when the model
 * names no icon, or names one that does not exist. Pure and server-safe: no UI imports.
 */
export const MODULE_ICONS = [
  'Users', 'User', 'Contact', 'UserCheck', 'UsersRound', 'GraduationCap', 'Stethoscope', 'Building2', 'Home', 'Landmark', 'Store', 'Factory',
  'Package', 'Truck', 'ShoppingCart', 'Receipt', 'Wallet', 'DollarSign', 'Banknote', 'CreditCard', 'Coins', 'PiggyBank', 'Handshake', 'Target',
  'Calendar', 'CalendarCheck', 'CalendarClock', 'Clock', 'ClipboardList', 'ClipboardCheck', 'CheckSquare', 'FileText', 'Folder', 'FolderKanban',
  'Mail', 'Phone', 'MessageSquare', 'Megaphone', 'Ticket', 'LifeBuoy', 'Headset', 'Wrench', 'Hammer', 'Car', 'Plane', 'MapPin', 'Map', 'Globe',
  'Utensils', 'Coffee', 'Leaf', 'Heart', 'Star', 'Award', 'Trophy', 'Gift', 'Tag', 'Tags', 'Layers', 'Key', 'Lock', 'Shield', 'Database', 'Boxes', 'Box', 'Palmtree', 'Bike', 'Camera', 'Music', 'Laptop', 'Cpu',
] as const

const RULES: [RegExp, string][] = [
  [/hostel|hotel|resort|lodg|guest ?house|property|properties|building|apartment|flat|estate|landlord|branch|campus|site/, 'Building2'],
  [/room|bed|suite|unit|accommodation/, 'Home'],
  [/book(ing)?s?\b|reservation|appointment|schedule|session|slot|visit/, 'CalendarCheck'],
  [/payment|invoice|receipt|bill|fee|charge|rent|transaction|ledger|paid|subscription/, 'Receipt'],
  [/expense|cost|spend|budget|salary|payroll|wage/, 'Wallet'],
  [/student|pupil|learner|alumni|trainee/, 'GraduationCap'],
  [/class|course|lesson|subject|curriculum|exam|grade|batch/, 'ClipboardList'],
  [/attendance|check ?in|presence|roll/, 'ClipboardCheck'],
  [/teacher|staff|employee|team|worker|agent|instructor|coach|tutor|doctor|nurse|driver/, 'UserCheck'],
  [/guardian|parent|family|relative|emergency/, 'UsersRound'],
  [/patient|medical|clinic|health|treatment|prescription/, 'Stethoscope'],
  [/customer|client|resident|tenant|guest|member|lead|contact|prospect|person|people|owner|supplier|vendor|donor|volunteer/, 'Users'],
  [/enquir|inquir|ticket|support|complaint|request|issue|case/, 'MessageSquare'],
  [/deal|opportunit|pipeline|sale|order|quote|proposal/, 'Handshake'],
  [/product|item|inventory|stock|asset|equipment|catalog/, 'Package'],
  [/deliver|shipment|transport|route|fleet|vehicle|trip/, 'Truck'],
  [/task|todo|checklist|job|work ?order|maintenance|repair/, 'CheckSquare'],
  [/project|campaign|programme|program|event/, 'FolderKanban'],
  [/document|contract|agreement|file|note|report|policy/, 'FileText'],
  [/menu|food|meal|kitchen|restaurant|recipe|canteen/, 'Utensils'],
  [/message|email|mail|newsletter/, 'Mail'],
  [/call|phone/, 'Phone'],
  [/lease|tenanc/, 'Key'],
  [/location|address|area|zone|region|city/, 'MapPin'],
]

export function suggestIcon(...names: string[]): string {
  const text = names.join(' ').toLowerCase()
  for (const [re, icon] of RULES) if (re.test(text)) return icon
  return 'Box'
}

const COLORS = ['#8ab4f8', '#34a853', '#9aa0a6', '#1a73e8', '#8e918f', '#c4c7c5']
export const suggestColor = (index: number) => COLORS[index % COLORS.length]

/** Keep a valid icon the model chose; otherwise guess from the module's own names. */
export function resolveIcon(icon: unknown, singular: string, plural: string, id: string): string {
  if (typeof icon === 'string' && (MODULE_ICONS as readonly string[]).includes(icon)) return icon
  return suggestIcon(singular, plural, id)
}
