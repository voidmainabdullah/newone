import { Menu } from '#/components/ui/Popover'
import { DOCK, MORE_TILE, type LandingMode } from './landingData'

const MORE_PROMPTS: { label: string; mode: LandingMode; prompt: string }[] = [
  { label: 'Import data from a file', mode: 'data', prompt: 'Add these contacts to my CRM and skip any duplicates' },
  { label: 'Sales pipeline', mode: 'build', prompt: 'Build a deals pipeline with stages Prospect, Negotiation, Won and Lost' },
  { label: 'Calculated field', mode: 'build', prompt: 'Add a field to Deals that shows the amount with 10% tax' },
  { label: 'Overdue reminders', mode: 'build', prompt: 'Create a rule that highlights tasks that are past their due date' },
]

function TileFace({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span
      className="flex size-[42px] items-center justify-center rounded-xl text-white shadow-[0_6px_16px_-8px_var(--tile-shadow)] ring-1 ring-black/5 transition group-hover:-translate-y-0.5 group-hover:brightness-110 group-active:scale-95 motion-reduce:transition-none"
      style={{ background: `linear-gradient(145deg, ${color}, color-mix(in srgb, ${color} 72%, #000))`, ['--tile-shadow' as string]: color }}
    >
      {children}
    </span>
  )
}

/** The row of quick-start tiles at the bottom of the landing page. Each one seeds the message box with an example request. */
export function LandingDock({ onPick }: { onPick: (prompt: string, mode: LandingMode) => void }) {
  return (
    <nav aria-label="Quick starts" className="scroll-thin -mx-5 overflow-x-auto px-5 pb-1">
      <div className="mx-auto flex w-max items-end gap-5">
        {DOCK.map((g) => (
          <div key={g.heading} className="flex flex-col items-center gap-2">
            <span className="text-[10px] font-medium tracking-[0.14em] text-muted-2 uppercase">{g.heading}</span>
            <div className="flex gap-2.5">
              {g.tiles.map((t) => (
                <button key={t.id} type="button" onClick={() => onPick(t.prompt, t.mode)} title={t.prompt} className="group flex w-[58px] flex-col items-center gap-1.5">
                  <TileFace color={t.color}><t.icon size={20} strokeWidth={1.9} /></TileFace>
                  <span className="max-w-full truncate text-[11px] text-muted transition group-hover:text-fg">{t.label}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
        <div className="flex flex-col items-center gap-2">
          <span className="text-[10px] tracking-[0.14em] uppercase opacity-0" aria-hidden>.</span>
          <Menu
            width={260}
            items={MORE_PROMPTS.map((m) => ({ label: m.label, onClick: () => onPick(m.prompt, m.mode) }))}
            trigger={({ toggle, ref }) => (
              <button ref={ref} type="button" onClick={toggle} aria-label="More quick starts" className="group flex w-[58px] flex-col items-center gap-1.5">
                <TileFace color={MORE_TILE.color}><MORE_TILE.icon size={20} strokeWidth={1.9} /></TileFace>
                <span className="text-[11px] text-muted transition group-hover:text-fg">{MORE_TILE.label}</span>
              </button>
            )}
          />
        </div>
      </div>
    </nav>
  )
}
