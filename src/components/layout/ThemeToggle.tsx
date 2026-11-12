import { Moon, Sun } from 'lucide-react'
import { cn } from '#/utils/id'
import { useTheme } from '#/stores/themeStore'

/** Small sun / moon switch: flips between the light and dark theme and remembers the choice in this browser. */
export function ThemeToggle({ className }: { className?: string }) {
  const resolved = useTheme((s) => s.resolved)
  const toggle = useTheme((s) => s.toggle)
  const next = resolved === 'dark' ? 'light' : 'dark'
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg text-muted transition hover:bg-surface hover:text-fg', className)}
    >
      {resolved === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  )
}
