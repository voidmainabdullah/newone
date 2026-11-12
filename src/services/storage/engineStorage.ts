import { normalizeDoc, type EngineDoc } from '#/engine/schema'
import { KEYS, readJson, writeJson } from './storageService'

/**
 * Engine configuration is persisted as a list of per-workspace documents under one key, like every other collection,
 * so backups, restores and the per-account namespace handle it without special cases. Plain JSON (JSONB friendly).
 */

export const serializeDocs = (docs: EngineDoc[]): string => JSON.stringify(docs)

/** Defensive read: anything malformed becomes an empty list / document, never an exception. One document per workspace id. */
export function parseDocs(raw: unknown): EngineDoc[] {
  let value = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return []
    }
  }
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: EngineDoc[] = []
  for (const d of value) {
    const doc = normalizeDoc(d)
    if (!doc.id || seen.has(doc.id)) continue
    seen.add(doc.id)
    out.push(doc)
  }
  return out
}

export const engineStorage = {
  load: (): EngineDoc[] => parseDocs(readJson<unknown>(KEYS.engine, [])),
  save: (docs: EngineDoc[]): boolean => writeJson(KEYS.engine, docs),
}
