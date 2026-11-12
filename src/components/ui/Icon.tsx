import { Box, Activity, AlertTriangle, AlignLeft, ArrowLeftRight, ArrowUpDown, BarChart3, Blocks, BookUser, Boxes, Briefcase, Building, Building2, Calendar, CalendarCheck, CalendarClock, CalendarDays, CheckSquare, ChevronDownSquare, CircleDot, ClipboardCheck, ClipboardList, Clock, Cog, Contact, Container, Crosshair, Database, DollarSign, Factory, FileBarChart, FileSpreadsheet, FileText, FileUser, Filter, Fingerprint, Folder, FolderKanban, FolderLock, FormInput, Gauge, Gem, Globe, Hammer, Handshake, Hash, Headset, HeartHandshake, History, Home, Image, KanbanSquare, KeyRound, Landmark, Laptop, LayoutDashboard, LayoutGrid, LayoutTemplate, LifeBuoy, LineChart, Link2, ListChecks, ListTodo, Lock, Magnet, Mail, MailCheck, MapPin, Megaphone, Network, Package, PackageCheck, Paintbrush, Palette, Palmtree, Paperclip, PenLine, PenSquare, Percent, Phone, PieChart, PiggyBank, Plug, Receipt, Rows3, ScanLine, Send, Settings, Share2, ShieldCheck, Ship, Sigma, Star, Store, Table2, Tags, Target, Ticket, ToggleLeft, TrendingUp, Trophy, Truck, Type, User, UserCheck, UserCog, UserPlus, UserSearch, Users, UsersRound, Wallet, Workflow, Wrench, Rocket, Zap, Heart, Flag, Bookmark, Bell, Camera, Coffee, Cloud, Code, CreditCard, Gift, Lightbulb, Music, Shield, ShoppingCart, Smile, Sun, Moon, Tag, Award, Bug, Calculator, Clipboard, Compass, Cpu, Eye, Hexagon, Inbox, Layers, Map, MessageSquare, Plane, Puzzle, Scale, Search, Server, Sparkles, Flame, Leaf, GraduationCap, Stethoscope, Car, Bike, Utensils, Banknote, Coins, BadgeCheck, PartyPopper, Plus, Check, X, Webhook, Terminal, GanttChart, Columns3, LayoutList, Grid2x2, GalleryHorizontal, Table, CalendarRange, Download, Upload, Link, Key, Unlock, HardDrive, Info } from 'lucide-react'
import { Pencil, Copy, Trash2, RotateCcw, Archive, SearchX, Play, Save, EyeOff, Settings2, Share, RefreshCw, Bolt, Wand2, Pin, Unlink, ExternalLink, FileJson, FileDown, FileUp, CircleCheck, Ban, UserMinus, LogOut, ShieldAlert, ListFilter, SlidersHorizontal, Expand } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

const EXTRA_ICONS = { Pencil, Copy, Trash2, RotateCcw, Archive, SearchX, Play, Save, EyeOff, Settings2, Share, RefreshCw, Bolt, Wand2, Pin, Unlink, ExternalLink, FileJson, FileDown, FileUp, CircleCheck, Ban, UserMinus, LogOut, ShieldAlert, ListFilter, SlidersHorizontal, Expand }

export const ICONS: Record<string, LucideIcon> = {
  ...EXTRA_ICONS,
  Activity, AlertTriangle, AlignLeft, ArrowLeftRight, ArrowUpDown, BarChart3, Blocks, BookUser, Box, Boxes, Briefcase, Building, Building2, Calendar, CalendarCheck, CalendarClock, CalendarDays, CheckSquare, ChevronDownSquare, CircleDot, ClipboardCheck, ClipboardList, Clock, Cog, Contact, Container, Crosshair, Database, DollarSign, Factory, FileBarChart, FileSpreadsheet, FileText, FileUser, Filter, Fingerprint, Folder, FolderKanban, FolderLock, FormInput, Gauge, Gem, Globe, Hammer, Handshake, Hash, Headset, HeartHandshake, History, Home, Image, KanbanSquare, KeyRound, Landmark, Laptop, LayoutDashboard, LayoutGrid, LayoutTemplate, LifeBuoy, LineChart, Link2, ListChecks, ListTodo, Lock, Magnet, Mail, MailCheck, MapPin, Megaphone, Network, Package, PackageCheck, Paintbrush, Palette, Palmtree, Paperclip, PenLine, PenSquare, Percent, Phone, PieChart, PiggyBank, Plug, Receipt, Rows3, ScanLine, Send, Settings, Share2, ShieldCheck, Ship, Sigma, Star, Store, Table2, Tags, Target, Ticket, ToggleLeft, TrendingUp, Trophy, Truck, Type, User, UserCheck, UserCog, UserPlus, UserSearch, Users, UsersRound, Wallet, Workflow, Wrench, Rocket, Zap, Heart, Flag, Bookmark, Bell, Camera, Coffee, Cloud, Code, CreditCard, Gift, Lightbulb, Music, Shield, ShoppingCart, Smile, Sun, Moon, Tag, Award, Bug, Calculator, Clipboard, Compass, Cpu, Eye, Hexagon, Inbox, Layers, Map, MessageSquare, Plane, Puzzle, Scale, Search, Server, Sparkles, Flame, Leaf, GraduationCap, Stethoscope, Car, Bike, Utensils, Banknote, Coins, BadgeCheck, PartyPopper, Plus, Check, X, Webhook, Terminal, GanttChart, Columns3, LayoutList, Grid2x2, GalleryHorizontal, Table, CalendarRange, Download, Upload, Link, Key, Unlock, HardDrive, Info,
}

/** Icons offered in the icon picker. */
export const PICKER_ICONS = [
  'Box', 'Boxes', 'Briefcase', 'Building2', 'Users', 'User', 'Contact', 'Target', 'Handshake', 'Wallet', 'DollarSign', 'Receipt', 'ShoppingCart',
  'Package', 'Truck', 'Home', 'Folder', 'FolderKanban', 'FileText', 'ClipboardList', 'CheckSquare', 'Calendar', 'Clock', 'Mail', 'Phone',
  'MessageSquare', 'Megaphone', 'Star', 'Heart', 'Flag', 'Bookmark', 'Bell', 'Rocket', 'Zap', 'Sparkles', 'Lightbulb', 'Award', 'Trophy', 'Gem',
  'Globe', 'MapPin', 'Plane', 'Car', 'Factory', 'Store', 'Landmark', 'GraduationCap', 'Stethoscope', 'Wrench', 'Hammer', 'Cog', 'Cpu', 'Database',
  'Server', 'Cloud', 'Code', 'Bug', 'Shield', 'Lock', 'Key', 'Tag', 'Tags', 'Layers', 'Puzzle', 'Compass', 'Map', 'Image', 'Camera', 'Music',
  'Coffee', 'Utensils', 'Leaf', 'Flame', 'Sun', 'Moon', 'Smile', 'Gift', 'PartyPopper', 'Headset', 'LifeBuoy', 'Inbox', 'Send', 'Calculator',
  'PiggyBank', 'Coins', 'Banknote', 'CreditCard', 'Scale', 'Laptop', 'Ticket', 'Palmtree', 'Magnet', 'Workflow', 'Network', 'Hexagon',
]

/** A bright, fixed palette (as in ClickUp's dark mode). Each icon name always gets the same colour. */
export const ICON_COLORS = ['#7b68ee', '#ff5c8a', '#ffa800', '#2dd4a7', '#3ea1ff', '#ffd43b', '#b388ff', '#ff7a59', '#4cd964', '#00c2e0']

export function iconColor(name?: string) {
  let h = 0
  for (const ch of name ?? 'Box') h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return ICON_COLORS[h % ICON_COLORS.length]
}

export function Icon({ name, size = 16, className, strokeWidth = 2, colorful }: { name?: string; size?: number; className?: string; strokeWidth?: number; colorful?: boolean }) {
  const C = (name && ICONS[name]) || Box
  // only icons inside a CRM view ask for colour; the app's own sidebar, tools and controls stay neutral
  const own = !!className && /\btext-/.test(className)
  return <C size={size} className={className} strokeWidth={strokeWidth} style={colorful && !own ? { color: iconColor(name) } : undefined} aria-hidden />
}
