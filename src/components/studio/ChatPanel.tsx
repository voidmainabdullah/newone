import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from 'lucide-react'
import type { Question } from '#/genius/blueprint/schema'
import type { QuestionAnswer } from '#/genius/state/types'
import type { ChatItem } from '#/stores/studioStore'
import { Icon } from '#/components/ui/Icon'
import { cn } from '#/utils/id'
import { ActivityCard } from './ActivityCard'
import { UserMessage } from './UserMessage'

export { Composer } from './Composer'

export const EXAMPLE_PROMPTS = [
  'A CRM for my school academy: students, guardians, classes, attendance and fees',
  'A CRM for a letting agency with landlords, properties, enquiries, tenancies and rent payments',
  'A sales CRM for a small agency: contacts, companies, deals and follow-ups',
]

/** A line of text that settles in out of a blur each time it changes. */
export function BlurText({ text, className }: { text: string; className?: string }) {
  return <span key={text} className={cn('blur-in inline-block', className)}>{text}</span>
}

function QaRow({ item }: { item: Extract<ChatItem, { kind: 'qa' }> }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rise-in">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left text-[13px] text-muted transition hover:text-fg">
        <ChevronRight size={14} className={cn('shrink-0 transition-transform duration-200', open && 'rotate-90')} />
        <span className="flex-1">{item.title}</span>
      </button>
      {open && (
        <dl className="ml-[7px] space-y-2 border-l border-line py-1 pl-5">
          {item.pairs.map((p, i) => (
            <div key={i}>
              <dt className="text-xs text-muted">{p.q}</dt>
              <dd className="mt-0.5 text-[13px]">{p.a}{p.auto && <span className="ml-2 text-[11px] text-muted-2">assumed</span>}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

const prefersReducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/** The conversation: you on the right, the AI on the left, no heavy borders. It scrolls down smoothly as lines arrive. */
export function ChatList({ chat, waiting, running, footer, onLink, className }: { chat: ChatItem[]; waiting: boolean; running: boolean; footer?: React.ReactNode; className?: string; onLink?: (link: NonNullable<Extract<ChatItem, { kind: 'assistant' }>['link']>) => void }) {
  const end = useRef<HTMLDivElement | null>(null)
  const first = useRef(true)
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end', behavior: first.current || prefersReducedMotion() ? 'auto' : 'smooth' })
    first.current = false
  }, [chat, waiting, running])
  return (
    <div className={cn('scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4', className)} aria-live="polite" data-testid="chat-list">
      {chat.map((c) => {
        if (c.kind === 'user') return <UserMessage key={c.id} text={c.text} />
        if (c.kind === 'assistant') {
          const text = <p className={cn(c.tone === 'error' ? 'shake-once' : 'rise-in', 'text-[13.5px] leading-relaxed break-words whitespace-pre-wrap', c.tone === 'muted' ? 'text-muted' : 'text-fg')}>{c.tone === 'error' && <Icon name="AlertTriangle" size={14} className="mr-1.5 inline -translate-y-px text-danger" />}{c.text}</p>
          if (!c.link) return <div key={c.id} className="max-w-[94%]">{text}</div>
          const link = c.link
          return <div key={c.id} className="max-w-[94%]">{text}<button type="button" data-testid="chat-link" onClick={() => onLink?.(link)} className="mt-2 flex h-8 items-center gap-1.5 rounded-lg bg-subtle/70 px-3 text-[13px] font-medium text-link transition hover:bg-subtle">{link.label}<ChevronRight size={14} /></button></div>
        }
        if (c.kind === 'steps') return <ActivityCard key={c.id} item={c} />
        if (c.kind === 'qa') return <QaRow key={c.id} item={c} />
        return null
      })}
      {waiting && !chat.some((c) => c.kind === 'steps' && c.outcome === 'waiting') && <p className="rise-in text-[13px] font-medium">Waiting for your answer</p>}
      {footer}
      <div ref={end} />
    </div>
  )
}

/** The docked card above the composer: one question at a time, radio options, "Write your own…", Skip and Submit. */
export function ClarifyDock({ questions, onSubmit, onSkip, disabled }: { questions: Question[]; onSubmit: (a: QuestionAnswer[]) => void; onSkip: () => void; disabled?: boolean }) {
  const [i, setI] = useState(0)
  const [picked, setPicked] = useState<Record<string, string>>({})
  const [own, setOwn] = useState<Record<string, boolean>>({})
  const [collapsed, setCollapsed] = useState(false)
  const q = questions[Math.min(i, questions.length - 1)]
  if (!q) return null
  const value = picked[q.id]
  const isOwn = own[q.id]
  const answerOf = (x: Question) => (picked[x.id] ?? '').trim() || x.safeDefault || x.options[0] || ''
  const canSubmit = !!value?.trim() || !!q.safeDefault || q.options.length > 0
  const submit = () => {
    if (!canSubmit || disabled) return
    const at = new Date().toISOString()
    onSubmit(questions.map((x) => ({ questionId: x.id, question: x.question, answer: answerOf(x) || 'Use your best judgement', at })))
  }
  return (
    <div className="mx-3 mb-2 overflow-hidden rounded-xl border border-line bg-surface" role="group" aria-label="Clarifying question">
      <div className="flex items-start gap-3 px-3.5 pt-3 pb-2">
        <p className="flex-1 text-[13px] leading-snug font-medium">{q.question}</p>
        <button type="button" aria-label={collapsed ? 'Expand question' : 'Collapse question'} onClick={() => setCollapsed((c) => !c)} className="mt-0.5 text-muted hover:text-fg">
          {collapsed ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </button>
      </div>
      {!collapsed && (
        <div className="space-y-0.5 px-2 pb-1" role="radiogroup" aria-label={q.question}>
          {q.options.map((o) => {
            const on = value === o && !isOwn
            return (
              <button key={o} type="button" role="radio" aria-checked={on} onClick={() => { setPicked((p) => ({ ...p, [q.id]: o })); setOwn((p) => ({ ...p, [q.id]: false })) }} className={cn('flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[13px] transition', on ? 'bg-subtle font-medium' : 'text-muted hover:bg-subtle/60 hover:text-fg')}>
                <Radio on={on} />{o}
              </button>
            )
          })}
          <div className={cn('flex items-center gap-3 rounded-lg px-2.5 py-1.5 text-[13px] transition', isOwn ? 'bg-subtle' : 'hover:bg-subtle/60')}>
            <button type="button" role="radio" aria-checked={!!isOwn} aria-label="Write your own answer" onClick={() => { setOwn((p) => ({ ...p, [q.id]: true })); setPicked((p) => ({ ...p, [q.id]: '' })) }}><Radio on={!!isOwn} /></button>
            <input aria-label={`Your own answer: ${q.question}`} value={isOwn ? (value ?? '') : ''} onFocus={() => { if (!isOwn) { setOwn((p) => ({ ...p, [q.id]: true })); setPicked((p) => ({ ...p, [q.id]: '' })) } }} onChange={(e) => setPicked((p) => ({ ...p, [q.id]: e.target.value }))} placeholder="Write your own..." className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-2" onKeyDown={(e) => e.key === 'Enter' && submit()} />
          </div>
        </div>
      )}
      <div className="flex items-center gap-1 border-t border-line px-2 py-2">
        <button type="button" aria-label="Previous question" disabled={i === 0} onClick={() => setI((n) => Math.max(0, n - 1))} className="flex size-7 items-center justify-center rounded-md text-muted hover:bg-subtle hover:text-fg disabled:opacity-30"><ChevronLeft size={16} /></button>
        <button type="button" aria-label="Next question" disabled={i >= questions.length - 1} onClick={() => setI((n) => Math.min(questions.length - 1, n + 1))} className="flex size-7 items-center justify-center rounded-md text-muted hover:bg-subtle hover:text-fg disabled:opacity-30"><ChevronRight size={16} /></button>
        {questions.length > 1 && <span className="ml-1 text-[11px] text-muted-2">{i + 1} of {questions.length}</span>}
        <button type="button" onClick={onSkip} disabled={disabled} className="ml-auto h-7 rounded-md px-2.5 text-[13px] text-muted hover:text-fg disabled:opacity-40">Skip</button>
        <button type="button" onClick={submit} disabled={!canSubmit || disabled} className="h-7 rounded-full bg-primary px-3.5 text-[13px] font-medium text-white transition hover:bg-primary-strong disabled:opacity-40">Submit</button>
      </div>
    </div>
  )
}

function Radio({ on }: { on: boolean }) {
  return <span aria-hidden className={cn('flex size-4 shrink-0 items-center justify-center rounded-full border', on ? 'border-primary' : 'border-line-strong')}>{on && <span className="size-2 rounded-full bg-primary" />}</span>
}

