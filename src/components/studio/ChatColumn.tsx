import type { ReactNode } from 'react'
import type { Question } from '#/genius/blueprint/schema'
import type { QuestionAnswer } from '#/genius/state/types'
import type { ChatItem } from '#/stores/studioStore'
import { cn } from '#/utils/id'
import { ChatList, ClarifyDock } from './ChatPanel'
import { Composer } from './Composer'

export interface ChatColumnProps {
  chat: ChatItem[]
  running: boolean
  asking: Question[] | null
  onSend: (text: string) => void
  onCancel: () => void
  onAnswers: (a: QuestionAnswer[]) => void
  onSkip: () => void
  onLink?: (link: NonNullable<Extract<ChatItem, { kind: 'assistant' }>['link']>) => void
  footer?: ReactNode
  seed?: string
  onSeedUsed?: () => void
  /** a roomy panel: keep the text and the box to a comfortable reading width in the middle */
  wide?: boolean
}

/**
 * The messages, the question card and the message box: the whole conversation, used by the Genius page and by the
 * floating panel alike (both read the same session, so it is one conversation). The box is fixed to the bottom, with a
 * soft shadow on its top edge; the messages scroll above it and stay readable while the AI works.
 */
export function ChatColumn(p: ChatColumnProps) {
  return (
    <>
      <ChatList chat={p.chat} running={p.running} waiting={!!p.asking} onLink={p.onLink} footer={p.footer} className={cn(p.wide && 'lg:px-[max(1rem,calc((100%-760px)/2))]')} />
      <div className="composer-dock relative z-[2] shrink-0 bg-app">
        <div className={cn(p.wide && 'mx-auto w-full max-w-[800px]')}>
          {p.asking && <ClarifyDock key={p.asking.map((q) => q.id).join()} questions={p.asking} onSubmit={p.onAnswers} onSkip={p.onSkip} disabled={p.running} />}
          <Composer onSend={p.onSend} onCancel={p.onCancel} running={p.running} seed={p.seed} onSeedUsed={p.onSeedUsed} />
        </div>
      </div>
    </>
  )
}
