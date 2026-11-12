import { create } from 'zustand'

export type ThemePref = 'dark' | 'light' | 'system'
export type ResolvedTheme = 'dark' | 'light'

export const THEME_KEY = 'blitcrm:theme'
const COLORS: Record<ResolvedTheme, string> = { dark: '#232422', light: '#ffffff' }

/**
 * Runs in the document head before the page paints, so the right theme is on screen from the first frame.
 * Keep it dependency free; it is serialised into an inline script.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var p=localStorage.getItem('${THEME_KEY}');if(p!=='light'&&p!=='dark'&&p!=='system')p='dark';var t=p==='system'?(window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'):p;var e=document.documentElement;e.classList.remove('dark','light');e.classList.add(t);e.setAttribute('data-theme',t);e.style.colorScheme=t;var m=document.querySelector('meta[name="color-scheme"]');if(m)m.setAttribute('content',t);var c=document.querySelector('meta[name="theme-color"]');if(c)c.setAttribute('content',t==='light'?'${COLORS.light}':'${COLORS.dark}');}catch(e){}})();`

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch { /* storage can be blocked; fall back to dark */ }
  return 'dark'
}

function resolve(pref: ThemePref): ResolvedTheme {
  if (pref !== 'system') return pref
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

/** Puts the theme on the page: html class, data attribute, native colour scheme and the browser chrome colour. */
export function applyTheme(theme: ResolvedTheme) {
  const el = document.documentElement
  el.classList.remove('dark', 'light')
  el.classList.add(theme)
  el.setAttribute('data-theme', theme)
  el.style.colorScheme = theme
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme)
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', COLORS[theme])
}

type ThemeState = {
  pref: ThemePref
  resolved: ResolvedTheme
  setPref: (pref: ThemePref) => void
  /** quick sun/moon switch: flips the theme that is currently showing */
  toggle: () => void
  hydrate: () => void
}

export const useTheme = create<ThemeState>((set, get) => ({
  pref: 'dark',
  resolved: 'dark',
  setPref: (pref) => {
    try { localStorage.setItem(THEME_KEY, pref) } catch { /* keep going without persistence */ }
    const resolved = resolve(pref)
    applyTheme(resolved)
    set({ pref, resolved })
  },
  toggle: () => get().setPref(get().resolved === 'dark' ? 'light' : 'dark'),
  hydrate: () => {
    const pref = readPref()
    const resolved = resolve(pref)
    applyTheme(resolved)
    set({ pref, resolved })
  },
}))

let watching = false
/** Reads the saved choice and follows the operating system while "System" is selected. Safe to call more than once. */
export function hydrateTheme() {
  useTheme.getState().hydrate()
  if (watching || typeof window === 'undefined' || !window.matchMedia) return
  watching = true
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (useTheme.getState().pref === 'system') useTheme.getState().hydrate()
  })
  window.addEventListener('storage', (e) => { if (e.key === THEME_KEY) useTheme.getState().hydrate() })
}
