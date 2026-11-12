import type { ReactNode } from 'react'

/**
 * The main navigation's own icons: inline SVG, one size and one stroke width, each section in its own soft colour.
 * No emoji and no icon font; the colour is set on the wrapper and the strokes follow it.
 */
/** colours come from the theme (see --nc-* in styles.css) so they stay readable on both light and dark surfaces */
export const NAV_COLORS = { dashboard: 'var(--nc-dashboard)', modules: 'var(--nc-modules)', tools: 'var(--nc-tools)', settings: 'var(--nc-settings)' } as const

const SIZE = 18
const STROKE = 1.75

function Svg({ children, color, className, size = SIZE }: { children: ReactNode; color: string; className?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" className={className} style={{ color }} aria-hidden>
      {children}
    </svg>
  )
}

export function DashboardIcon({ className, size }: { className?: string; size?: number }) {
  return (
    <Svg size={size} color={NAV_COLORS.dashboard} className={className}>
      <rect x="3.5" y="3.5" width="7" height="9" rx="1.8" />
      <rect x="13.5" y="3.5" width="7" height="5" rx="1.8" />
      <rect x="13.5" y="11.5" width="7" height="9" rx="1.8" />
      <rect x="3.5" y="15.5" width="7" height="5" rx="1.8" />
    </Svg>
  )
}

export function ModulesIcon({ className, size }: { className?: string; size?: number }) {
  return (
    <Svg size={size} color={NAV_COLORS.modules} className={className}>
      <path d="M12 3 20 7.5v9L12 21l-8-4.5v-9L12 3Z" />
      <path d="m4 7.5 8 4.5 8-4.5" />
      <path d="M12 12v9" />
    </Svg>
  )
}

export function ToolsIcon({ className, size }: { className?: string; size?: number }) {
  return (
    <Svg size={size} color={NAV_COLORS.tools} className={className}>
      <path d="M14.7 6.3a4 4 0 0 0 4.9 4.9l-9.4 9.4a2.1 2.1 0 0 1-3-3l9.4-9.4a4 4 0 0 0-1.9-1.9Z" />
      <path d="m15.5 5.5 2.2-2.2 3 3-2.2 2.2" />
    </Svg>
  )
}

export function SettingsIcon({ className, size }: { className?: string; size?: number }) {
  return (
    <Svg size={size} color={NAV_COLORS.settings} className={className}>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2.2" />
      <circle cx="9" cy="17" r="2.2" />
    </Svg>
  )
}

/** the Genius Studio sparkle (it sits on a dark tile, so it is white) */
export function SparkleIcon({ size = SIZE, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M10 2.5c.4 3.9 1.6 5.1 5.5 5.5-3.9.4-5.1 1.6-5.5 5.5-.4-3.9-1.6-5.1-5.5-5.5C8.4 7.6 9.6 6.4 10 2.5Z" />
      <path d="M18 12.5c.25 2.4 1 3.1 3.4 3.4-2.4.25-3.1 1-3.4 3.4-.25-2.4-1-3.1-3.4-3.4 2.4-.3 3.1-1 3.4-3.4Z" opacity="0.9" />
      <path d="M7 15c.2 1.7.7 2.2 2.4 2.4C7.7 17.6 7.2 18.1 7 19.8c-.2-1.7-.7-2.2-2.4-2.4C6.3 17.2 6.8 16.7 7 15Z" opacity="0.8" />
    </svg>
  )
}
