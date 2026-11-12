import { useEffect, useRef, useState } from 'react'

/**
 * A message from the person: right side, soft background, no border. A long one is folded to about five lines with
 * "See more" / "Show less". That is display only: the full text is what was sent and is what is kept here.
 */
export function UserMessage({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      // while folded the box is clamped, so its content being taller than the box means there is more to show
      if (!expanded) setOverflowing(el.scrollHeight > el.clientHeight + 1)
    }
    measure()
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [text, expanded])
  return (
    <div className="rise-in flex justify-end" data-testid="user-message">
      <div className="max-w-[88%] rounded-2xl rounded-br-md bg-subtle/70 px-3.5 py-2 text-[13.5px] leading-relaxed">
        <div ref={ref} className={expanded ? 'break-words whitespace-pre-wrap [overflow-wrap:anywhere]' : 'line-clamp-5 break-words whitespace-pre-wrap [overflow-wrap:anywhere]'}>{text}</div>
        {(overflowing || expanded) && (
          <button type="button" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)} className="mt-1 text-xs font-medium text-link hover:underline">{expanded ? 'Show less' : 'See more'}</button>
        )}
      </div>
    </div>
  )
}
