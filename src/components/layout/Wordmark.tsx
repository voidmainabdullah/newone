import { cn } from '#/utils/id'

/** The Blitcrm wordmark: the white logo on the dark theme, the dark logo on the light theme (switched in CSS, so no flash). */
export function Wordmark({ height = 44, className }: { height?: number; className?: string }) {
  return (
    <span className={cn('inline-flex items-center', className)}>
      <img src="/brand/logo-white.png" alt="Blitcrm" style={{ height }} className="logo-for-dark w-auto object-contain" />
      <img src="/brand/logo-dark.png" alt="" aria-hidden style={{ height }} className="logo-for-light w-auto object-contain" />
    </span>
  )
}
