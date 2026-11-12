import { useId } from 'react'
import { STARTER_TEMPLATES } from '#/services/onboarding'
import { Icon } from '#/components/ui/Icon'
import { cn } from '#/utils/id'

/** "Start blank" (default) or "Start from a template". `value` is null for blank, otherwise a template id. */
export function StartChooser({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
  const group = useId()
  const template = value !== null
  const option = (on: boolean, title: string, hint: string, pick: () => void) => (
    <label className={cn('flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition', on ? 'border-primary bg-subtle' : 'border-line hover:bg-surface')}>
      <input type="radio" name={group} className="mt-0.5 size-4 accent-[var(--primary)]" checked={on} onChange={pick} />
      <span className="min-w-0"><span className="block text-[13px] font-medium">{title}</span><span className="mt-0.5 block text-xs text-muted">{hint}</span></span>
    </label>
  )
  return (
    <fieldset className="space-y-2">
      <legend className="section-label mb-2">Starting point</legend>
      {option(!template, 'Start blank', 'No modules and nothing in the sidebar. Describe your CRM in Studio, or add modules yourself.', () => onChange(null))}
      {option(template, 'Start from a template', 'Begin with a ready-made set of modules, then change anything.', () => onChange(value ?? STARTER_TEMPLATES[0]?.id ?? null))}
      {template && (
        <div className="grid max-h-56 gap-1.5 overflow-y-auto pl-1" role="radiogroup" aria-label="Template">
          {STARTER_TEMPLATES.map((t) => (
            <button key={t.id} type="button" role="radio" aria-checked={value === t.id} onClick={() => onChange(t.id)} className={cn('flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-[13px] transition', value === t.id ? 'border-primary bg-subtle' : 'border-line hover:bg-surface')}>
              <Icon name={t.icon} size={15} className="shrink-0 text-muted" />
              <span className="min-w-0 flex-1"><span className="block truncate font-medium">{t.name}</span><span className="block truncate text-xs text-muted">{t.description}</span></span>
            </button>
          ))}
        </div>
      )}
    </fieldset>
  )
}
