import { useEffect, useRef, useState } from 'react'
import { ArrowUp, ChevronDown, Mic, Paperclip, Plus, Square, X, Zap } from 'lucide-react'
import { useStudioLayout } from '#/stores/studioLayoutStore'
import { toast } from '#/utils/toast'
import { cn } from '#/utils/id'
import { Menu } from '#/components/ui/Popover'
import { useDictation } from '#/hooks/useDictation'
import { MODES, SUGGESTIONS, type LandingMode } from './landingData'

const MAX_CHARS = 40000
const MAX_FILE_CHARS = 20000
const ACCEPT = '.txt,.csv,.tsv,.md,.json,text/plain,text/csv,application/json'

interface Attachment { name: string; text: string }

export const focusComposer = () => document.getElementById('studio-request')?.focus()

/**
 * The message box. It is the same box on the Genius page and in the floating panel: the unsent text lives in the layout
 * store, so it survives switching between them and keeps its place while the AI works. Enter sends, Shift+Enter starts a
 * new line, and the box grows with what is typed. While a task runs the Send button becomes Stop (typing stays possible).
 * `hero` is the large first-screen version with the animated gradient outline.
 */
export function Composer({ onSend, onCancel, running, disabled, seed, onSeedUsed, hero, placeholder, mode = 'ask', onMode }: { hero?: boolean; mode?: LandingMode; onMode?: (m: LandingMode) => void; onSend: (text: string) => void; onCancel: () => void; running: boolean; disabled?: boolean; seed?: string; onSeedUsed?: () => void; placeholder?: string }) {
  const text = useStudioLayout((s) => s.draft)
  const setText = useStudioLayout((s) => s.setDraft)
  const [files, setFiles] = useState<Attachment[]>([])
  const ref = useRef<HTMLTextAreaElement | null>(null)
  const pick = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (seed) {
      setText(seed)
      onSeedUsed?.()
      ref.current?.focus()
    }
  }, [seed, onSeedUsed, setText])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, hero ? 220 : 180)}px`
  }, [text, hero])

  const dictation = useDictation((t) => setText((useStudioLayout.getState().draft ? useStudioLayout.getState().draft + ' ' : '') + t))
  const modeInfo = MODES.find((m) => m.id === mode) ?? MODES[0]
  const canSend = (text.trim().length > 0 || files.length > 0) && !running && !disabled
  const send = () => {
    if (!canSend) return
    // attached text goes to the AI whole, after what was typed
    const full = [text.trim(), ...files.map((f) => `[Attached file: ${f.name}]\n${f.text}`)].filter(Boolean).join('\n\n')
    if (full.length > MAX_CHARS) {
      toast.error('That message is too long', 'Send it in smaller parts. Nothing was cut off.')
      return
    }
    onSend(full)
    setText('')
    setFiles([])
  }
  const attach = async (list: FileList | null) => {
    if (!list) return
    for (const f of Array.from(list)) {
      if (f.size > 400_000) { toast.error('That file is too large', `Make ${f.name} smaller and try again.`); continue }
      const t = await f.text()
      if (t.length > MAX_FILE_CHARS) { toast.error('That file is too long', `${f.name} has more than ${MAX_FILE_CHARS.toLocaleString()} characters. Send it in smaller parts.`); continue }
      if (t.includes('\u0000')) { toast.error('That file cannot be read', `${f.name} does not look like a text file.`); continue }
      setFiles((p) => [...p, { name: f.name, text: t }])
    }
    if (pick.current) pick.current.value = ''
  }

  const box = (
    <div className={cn('relative flex flex-col bg-surface', hero ? 'rounded-[20px] px-4 pt-3.5 pb-3 shadow-pop' : 'rounded-2xl border border-line/70 px-3 pt-2.5 pb-2 transition-colors focus-within:border-line-strong')}>
      {files.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1.5" aria-label="Attached files">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex max-w-full items-center gap-1 rounded-full bg-subtle py-0.5 pr-1 pl-2.5 text-xs">
              <span className="truncate">{f.name}</span>
              <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((p) => p.filter((_, j) => j !== i))} className="flex size-4 items-center justify-center rounded-full text-muted hover:bg-line hover:text-fg"><X size={11} /></button>
            </li>
          ))}
        </ul>
      )}
      <textarea
        ref={ref}
        id="studio-request"
        aria-label="Message to Genius Studio"
        rows={hero ? 2 : 1}
        maxLength={MAX_CHARS}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            send()
          }
        }}
        placeholder={placeholder ?? (hero ? modeInfo.placeholder : 'Ask Genius Studio anything, or tell it what to build...')}
        className={cn('block w-full resize-none bg-transparent outline-none placeholder:text-muted-2', hero ? 'max-h-56 min-h-[56px] text-[15px] leading-relaxed' : 'max-h-44 min-h-[24px] text-[13.5px]')}
      />
      <input ref={pick} type="file" accept={ACCEPT} multiple className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => void attach(e.target.files)} />
      {hero ? (
        <div className="mt-3 flex items-center gap-1.5">
          <button type="button" aria-label="Attach a file" title="Attach a text file (txt, csv, md, json)" onClick={() => pick.current?.click()} className="flex size-8 items-center justify-center rounded-full border border-line text-muted transition hover:bg-subtle hover:text-fg"><Plus size={16} /></button>
          <Menu
            align="left"
            width={300}
            items={SUGGESTIONS[mode].map((t) => ({ label: t, onClick: () => { setText(t); ref.current?.focus() } }))}
            trigger={({ toggle, ref: r }) => (
              <button ref={r} type="button" onClick={toggle} className="flex h-8 items-center gap-1.5 rounded-full border border-line px-3 text-xs text-muted transition hover:bg-subtle hover:text-fg"><Zap size={13} />Skills</button>
            )}
          />
          <span className="ml-auto" />
          <Menu
            width={170}
            items={MODES.map((m) => ({ label: m.label, hint: m.id === mode ? 'Selected' : undefined, onClick: () => onMode?.(m.id) }))}
            trigger={({ toggle, ref: r }) => (
              <button ref={r} type="button" onClick={toggle} aria-label="Choose a mode" className="flex h-8 items-center gap-1 rounded-full px-2.5 text-xs text-muted transition hover:bg-subtle hover:text-fg">{modeInfo.label}<ChevronDown size={13} /></button>
            )}
          />
          {running ? (
            <button type="button" aria-label="Stop" title="Stop" onClick={onCancel} className="flex size-9 items-center justify-center rounded-full bg-fg text-app transition hover:opacity-90"><Square size={11} fill="currentColor" /></button>
          ) : canSend || !dictation.supported ? (
            <button type="button" aria-label="Send" title="Send" onClick={send} disabled={!canSend} className="flex size-9 items-center justify-center rounded-full bg-fg text-app transition hover:opacity-90 disabled:bg-subtle disabled:text-muted-2 disabled:hover:opacity-100"><ArrowUp size={16} /></button>
          ) : (
            <button type="button" aria-label={dictation.listening ? 'Stop listening' : 'Speak your request'} title={dictation.listening ? 'Stop listening' : 'Speak your request'} onClick={dictation.toggle} className={cn('flex size-9 items-center justify-center rounded-full transition', dictation.listening ? 'bg-danger text-white motion-safe:animate-pulse' : 'bg-fg text-app hover:opacity-90')}><Mic size={16} /></button>
          )}
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-1.5">
          <button type="button" aria-label="Attach a file" title="Attach a text file (txt, csv, md, json)" onClick={() => pick.current?.click()} className="flex size-8 items-center justify-center rounded-full text-muted transition hover:bg-subtle hover:text-fg"><Paperclip size={16} /></button>
          <span className="ml-auto text-[11px] text-muted-2 max-sm:hidden">Enter to send · Shift+Enter for a new line</span>
          {running ? (
            <button type="button" aria-label="Stop" title="Stop" onClick={onCancel} className="flex size-8 items-center justify-center rounded-full bg-fg text-app transition hover:opacity-90"><Square size={11} fill="currentColor" /></button>
          ) : (
            <button type="button" aria-label="Send" title="Send" onClick={send} disabled={!canSend} className="flex size-8 items-center justify-center rounded-full bg-fg text-app transition hover:opacity-90 disabled:bg-subtle disabled:text-muted-2 disabled:hover:opacity-100"><ArrowUp size={16} /></button>
          )}
        </div>
      )}
    </div>
  )

  if (hero) return <div className="fog-input w-full">{box}</div>
  return <div className="px-3 pt-2 pb-3">{box}</div>
}
