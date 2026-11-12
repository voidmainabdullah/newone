import { create } from 'zustand'

/**
 * Where the Genius panels are and how wide: the chat and preview panels (each can be collapsed on its own, the chat width
 * can be dragged), the floating launcher panel, and the unsent text in the composer (shared by every composer, so what you
 * typed is still there when you switch between the page and the launcher). Layout is kept in localStorage.
 */
const KEY = 'blitcrm:studio-layout:v1'
export const MIN_CHAT = 320
export const MIN_PREVIEW = 360
export const DEFAULT_CHAT = 420

interface Persisted {
  chatOpen: boolean
  /** null = never chosen: the preview follows the work (it opens when something is built) */
  previewOpen: boolean | null
  chatWidth: number
  launcher: 'closed' | 'open' | 'minimized'
}

interface LayoutState extends Persisted {
  draft: string
  setDraft: (t: string) => void
  setChatOpen: (v: boolean) => void
  setPreviewOpen: (v: boolean | null) => void
  setChatWidth: (w: number) => void
  setLauncher: (v: Persisted['launcher']) => void
  /** open the preview because the work affects it (never closes anything) */
  revealPreview: () => void
}

const DEFAULTS: Persisted = { chatOpen: true, previewOpen: null, chatWidth: DEFAULT_CHAT, launcher: 'closed' }

function load(): Persisted {
  if (typeof localStorage === 'undefined') return DEFAULTS
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULTS
    const p = JSON.parse(raw) as Partial<Persisted>
    return {
      chatOpen: typeof p.chatOpen === 'boolean' ? p.chatOpen : DEFAULTS.chatOpen,
      previewOpen: typeof p.previewOpen === 'boolean' ? p.previewOpen : null,
      chatWidth: typeof p.chatWidth === 'number' && p.chatWidth >= MIN_CHAT && p.chatWidth <= 1400 ? p.chatWidth : DEFAULTS.chatWidth,
      // the floating panel never reopens by itself after a reload
      launcher: p.launcher === 'minimized' ? 'minimized' : 'closed',
    }
  } catch {
    return DEFAULTS
  }
}

function save(s: Persisted) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ chatOpen: s.chatOpen, previewOpen: s.previewOpen, chatWidth: s.chatWidth, launcher: s.launcher }))
  } catch { /* storage unavailable */ }
}

export const useStudioLayout = create<LayoutState>((set, get) => ({
  ...DEFAULTS,
  draft: '',
  setDraft: (draft) => set({ draft }),
  setChatOpen: (chatOpen) => { set({ chatOpen }); save(get()) },
  setPreviewOpen: (previewOpen) => { set({ previewOpen }); save(get()) },
  setChatWidth: (chatWidth) => { set({ chatWidth: Math.round(chatWidth) }); save(get()) },
  setLauncher: (launcher) => { set({ launcher }); save(get()) },
  revealPreview: () => { if (get().previewOpen !== true) { set({ previewOpen: true }); save(get()) } },
}))

/** Called once on the client: the layout is read after hydration so the server and first client render agree. */
export function hydrateStudioLayout() {
  const p = load()
  useStudioLayout.setState(p)
}
