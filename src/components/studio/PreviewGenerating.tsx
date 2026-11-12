import { useEffect, useState } from 'react'

/**
 * What the Preview panel shows while a task works: one line of soft gradient text, picked from what is actually being done.
 * Each new line comes in out of a blur. When the work ends the layer fades away over the finished preview, which is
 * already rendered underneath, so the result is visible the moment it is done. No graphics, no loader.
 */
export function PreviewGenerating({ active, line }: { active: boolean; line: string }) {
  const [mounted, setMounted] = useState(active)
  const [visible, setVisible] = useState(active)
  useEffect(() => {
    if (active) {
      setMounted(true)
      const r = requestAnimationFrame(() => setVisible(true))
      return () => cancelAnimationFrame(r)
    }
    setVisible(false)
    const t = setTimeout(() => setMounted(false), 450)
    return () => clearTimeout(t)
  }, [active])
  if (!mounted) return null
  return (
    <div
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-app transition-opacity duration-[400ms] ease-out"
      style={{ opacity: visible ? 1 : 0 }}
      data-testid="preview-generating"
      role="status"
      aria-live="polite"
    >
      <span key={line} className="gen-text text-[22px] font-medium tracking-tight sm:text-[26px]">{line}</span>
    </div>
  )
}
