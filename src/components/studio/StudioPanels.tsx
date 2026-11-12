import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Eye, MessageSquare, PanelLeftClose, PanelRightClose } from 'lucide-react'
import { MIN_CHAT, MIN_PREVIEW, useStudioLayout } from '#/stores/studioLayoutStore'
import { cn } from '#/utils/id'

const DIVIDER = 12
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/** The button in a panel's header that folds the panel away; the panel then leaves a slim rail that brings it back. */
export function CollapseButton({ side }: { side: 'chat' | 'preview' }) {
  const chatOpen = useStudioLayout((s) => s.chatOpen)
  const previewOpen = useStudioLayout((s) => s.previewOpen)
  const setChat = useStudioLayout((s) => s.setChatOpen)
  const setPreview = useStudioLayout((s) => s.setPreviewOpen)
  // the last open panel cannot be folded: there would be nothing left on screen
  const other = side === 'chat' ? previewOpen !== false : chatOpen
  const label = side === 'chat' ? 'Collapse chat' : 'Collapse preview'
  return (
    <button type="button" aria-label={label} title={other ? label : 'The other panel is collapsed'} disabled={!other} onClick={() => (side === 'chat' ? setChat(false) : setPreview(false))} className="flex size-8 items-center justify-center rounded-lg text-muted transition hover:bg-surface hover:text-fg disabled:opacity-40 max-lg:hidden">
      {side === 'chat' ? <PanelLeftClose size={15} /> : <PanelRightClose size={15} />}
    </button>
  )
}

function Rail({ label, icon, onClick, side }: { label: string; icon: ReactNode; onClick: () => void; side: 'chat' | 'preview' }) {
  return (
    <button type="button" aria-label={`Open ${label.toLowerCase()}`} title={`Open ${label.toLowerCase()}`} onClick={onClick} data-testid={`rail-${side}`} className="group flex w-10 shrink-0 flex-col items-center gap-3 rounded-xl border border-line bg-app py-3 text-muted transition hover:border-line-strong hover:bg-surface hover:text-fg max-lg:hidden">
      {icon}
      <span className="text-xs font-medium [writing-mode:vertical-rl]">{label}</span>
    </button>
  )
}

/**
 * Chat and Preview side by side on a wide screen: each folds away on its own (and comes back from its rail), and the
 * divider between them can be dragged. Neither can get narrower than a usable width and they never overlap. On a phone the
 * two are tabs (`mobile`). The layout is remembered in this browser.
 */
export function StudioPanels({ chat, preview, mobile, previewDefault }: { chat: ReactNode; preview: ReactNode; mobile: 'chat' | 'preview'; previewDefault: boolean }) {
  const chatOpen = useStudioLayout((s) => s.chatOpen)
  const previewPref = useStudioLayout((s) => s.previewOpen)
  const chatWidth = useStudioLayout((s) => s.chatWidth)
  const setChatWidth = useStudioLayout((s) => s.setChatWidth)
  const setChatOpen = useStudioLayout((s) => s.setChatOpen)
  const setPreviewOpen = useStudioLayout((s) => s.setPreviewOpen)
  const previewOpen = previewPref ?? previewDefault
  const wrap = useRef<HTMLDivElement | null>(null)
  const [wrapW, setWrapW] = useState(1100)
  const [drag, setDrag] = useState<number | null>(null)
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWrapW(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const both = chatOpen && previewOpen
  const maxChat = Math.max(MIN_CHAT, wrapW - MIN_PREVIEW - DIVIDER)
  const width = clamp(drag ?? chatWidth, MIN_CHAT, maxChat)

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const el = wrap.current
    if (!el) return
    const left = el.getBoundingClientRect().left
    const target = e.currentTarget
    target.setPointerCapture(e.pointerId)
    let last = width
    const move = (ev: PointerEvent) => { last = clamp(ev.clientX - left - DIVIDER / 2, MIN_CHAT, maxChat); setDrag(last) }
    const up = () => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      target.removeEventListener('pointercancel', up)
      setChatWidth(last)
      setDrag(null)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
    target.addEventListener('pointercancel', up)
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); setChatWidth(clamp(width - 24, MIN_CHAT, maxChat)) }
    if (e.key === 'ArrowRight') { e.preventDefault(); setChatWidth(clamp(width + 24, MIN_CHAT, maxChat)) }
  }

  return (
    <div ref={wrap} className={cn('flex min-h-0 flex-1 px-3 pb-6 lg:pr-5', !both && 'lg:gap-3')}>
      <section aria-label="Chat" className={cn('flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-app max-lg:w-full', both ? 'lg:shrink-0 lg:basis-[var(--cw)]' : 'lg:flex-1', !chatOpen && 'lg:hidden', mobile !== 'chat' && 'max-lg:hidden')} style={{ '--cw': `${width}px` } as React.CSSProperties} data-testid="panel-chat">
        {chat}
      </section>
      {!chatOpen && <Rail side="chat" label="Chat" icon={<MessageSquare size={16} />} onClick={() => setChatOpen(true)} />}

      {both && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize chat and preview"
          aria-valuemin={MIN_CHAT}
          aria-valuemax={maxChat}
          aria-valuenow={Math.round(width)}
          tabIndex={0}
          onPointerDown={onDown}
          onKeyDown={onKey}
          onDoubleClick={() => setChatWidth(420)}
          className="group relative flex w-3 shrink-0 cursor-col-resize touch-none items-center justify-center outline-none max-lg:hidden"
          data-testid="panel-divider"
        >
          <span className={cn('h-10 w-[3px] rounded-full bg-line-strong/0 transition group-hover:bg-line-strong group-focus-visible:bg-primary', drag !== null && 'h-16 bg-primary')} />
        </div>
      )}

      <section aria-label="Preview" className={cn('relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-app', !previewOpen && 'lg:hidden', mobile !== 'preview' && 'max-lg:hidden', drag !== null && 'select-none')} data-testid="panel-preview">
        {preview}
      </section>
      {!previewOpen && <Rail side="preview" label="Preview" icon={<Eye size={16} />} onClick={() => setPreviewOpen(true)} />}
    </div>
  )
}
