import type { Module } from '#/types'
import { fieldAccess, canModule, type Actor } from '../permissions/policy'
import { newCorrelationId } from '../ai/observability'
import type { GenerateWire, Transport } from '../ai/wire'
import { QuerySpec } from './spec'

/** The schema the model may use to plan a search: ids, labels, types, a few option labels and the links between modules. Never records. */
export interface SearchCatalog {
  today: string
  catalog: { id: string; name: string; fields: { id: string; label: string; type: string; options?: string[]; links?: string }[] }[]
}

export function searchCatalog(modules: Module[], workspaceId: string, actor: Actor, now = new Date()): SearchCatalog {
  return {
    today: now.toISOString().slice(0, 10),
    catalog: modules
      .filter((m) => m.workspaceId === workspaceId && !m.archived && !m.system && canModule(actor.role, m, 'view'))
      .slice(0, 24)
      .map((m) => ({
        id: m.id,
        name: m.name,
        fields: m.fields
          .filter((f) => fieldAccess(actor.role, f) !== 'hidden' && !['file', 'image', 'document', 'signature', 'password'].includes(f.type))
          .slice(0, 24)
          .map((f) => ({
            id: f.id,
            label: f.label,
            type: f.type,
            ...(f.options?.length ? { options: f.options.slice(0, 8).map((o) => o.label) } : {}),
            ...(f.relation ? { links: modules.find((x) => x.id === f.relation!.moduleId)?.name ?? f.relation.moduleId } : {}),
          })),
      })),
  }
}

export type PlanResult = { ok: true; spec: QuerySpec; summary: string; assumptions: string[] } | { ok: false; message: string; retryable: boolean }

/** Ask the model to turn plain words into a QuerySpec. The result is validated here; it is never run without the local compiler. */
export async function planSearch(request: string, workspaceId: string, catalog: SearchCatalog, transport: Transport, signal?: AbortSignal): Promise<PlanResult> {
  const wire: GenerateWire = { workspaceId, correlationId: newCorrelationId(), operation: 'question', kind: 'queryspec', mode: 'generate', tier: 'fast', variable: { request: request.slice(0, 600), context: catalog } }
  const res = await Promise.race([transport(wire), new Promise<never>((_, rej) => signal?.addEventListener('abort', () => rej(new Error('cancelled')), { once: true }))]).catch((e: Error) => ({ ok: false as const, code: 'unavailable' as const, message: e.message === 'cancelled' ? 'Cancelled.' : 'Could not reach the AI service.', retryable: true }))
  if (!res.ok) return { ok: false, message: res.message, retryable: res.retryable }
  const env = res.envelope
  if (env.status !== 'ok' || !env.queryspec) return { ok: false, message: env.summary || 'I could not turn that into a search with the fields of this workspace. Try naming the module and the field.', retryable: false }
  const parsed = QuerySpec.safeParse(env.queryspec)
  if (!parsed.success) return { ok: false, message: 'The AI returned a search that did not fit the format. Try again or reword it.', retryable: true }
  return { ok: true, spec: parsed.data, summary: env.summary ?? '', assumptions: env.assumptions ?? [] }
}
