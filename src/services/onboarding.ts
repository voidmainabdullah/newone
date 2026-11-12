import type { Template } from '#/types'
import { BUILTIN_TEMPLATES, coreTemplate } from '#/templates'

/** Templates offered when choosing "Start from a template" (signup and new project). */
export const STARTER_TEMPLATES: Template[] = [coreTemplate, ...BUILTIN_TEMPLATES]

const KEY = 'sortblink:start'

/** What the account chose at signup. `null` (the default) means a blank home workspace with zero modules. */
export function setPendingStart(templateId: string | null) {
  try {
    if (templateId) window.localStorage.setItem(KEY, templateId)
    else window.localStorage.removeItem(KEY)
  } catch {
    /* storage unavailable: the app starts blank */
  }
}

/** Read once when the first workspace is created, then forgotten. */
export function consumePendingStart(): Template | null {
  try {
    const id = window.localStorage.getItem(KEY)
    window.localStorage.removeItem(KEY)
    return (id && STARTER_TEMPLATES.find((t) => t.id === id)) || null
  } catch {
    return null
  }
}
