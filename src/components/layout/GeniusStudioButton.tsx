import { cn } from '#/utils/id'
import { useStudioLayout } from '#/stores/studioLayoutStore'
import { focusComposer } from '#/components/studio/Composer'
import { usePathname } from './AppLink'
import { SparkleIcon } from './NavIcons'

/** The small dark tile that carries the sparkle. */
export function StudioTile({ size = 26, className }: { size?: number; className?: string }) {
  return (
    <span className={cn('gs-tile', className)} style={{ width: size, height: size, borderRadius: Math.round(size * 0.3) }} aria-hidden>
      <SparkleIcon size={Math.round(size * 0.55)} />
    </span>
  )
}

type Variant = 'full' | 'compact' | 'rail'

/**
 * "Genius Studio": one conversation everywhere. On the Genius page it focuses the message box; elsewhere it opens the
 * floating panel. Styled as a dark surface with a hairline border and soft glow; only the label is gradient.
 */
export function GeniusStudioButton({ onDone, variant = 'full' }: { onDone?: () => void; variant?: Variant }) {
  const pathname = usePathname()
  const launcher = useStudioLayout((s) => s.launcher)
  const setLauncher = useStudioLayout((s) => s.setLauncher)
  const onGenius = pathname === '/genius'
  const click = () => {
    if (onGenius) focusComposer()
    else setLauncher(launcher === 'open' ? 'minimized' : 'open')
    onDone?.()
  }
  const size = variant === 'full' ? 'h-10 w-full' : variant === 'compact' ? 'h-8' : 'size-10'
  return (
    <button type="button" onClick={click} aria-label="Genius Studio" title="Genius Studio" className={cn('gs-btn', size)}>
      <span className={cn('gs-face', variant === 'rail' ? 'justify-center' : variant === 'compact' ? 'gap-2 px-1.5 pr-3' : 'px-2')}>
        <StudioTile size={variant === 'full' ? 26 : variant === 'compact' ? 22 : 28} />
        {variant !== 'rail' && <span className={cn('gs-text', variant === 'compact' ? 'text-[13px]' : 'text-[13.5px]')}>Genius Studio</span>}
      </span>
    </button>
  )
}
