import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { projectIdFor } from '#/genius/compiler/ids'
import { submitProposal } from '#/genius/service/builder'
import { applyProposal } from '#/genius/service/actions'
import { useModuleStore } from '#/stores/moduleStore'
import { useWorkspaceStore } from '#/stores/workspaceStore'
import { resetWorld, TENANT, WS } from './helpers'

const blueprint = () => {
  const bp = JSON.parse(readFileSync(new URL('./fixtures/ai-letting-blueprint.json', import.meta.url), 'utf8'))
  bp.meta.projectId = projectIdFor(TENANT, WS)
  bp.meta.revisionId = 'rev_none'
  for (const r of bp.relationships) r.deletePolicy = 'restrict'
  for (const r of bp.roles) r.grants = r.grants.filter((g: string) => g !== 'accessSettings')
  return bp
}

describe('a new project gets its own empty workspace', () => {
  it('builds into a new project and leaves the current workspace untouched', () => {
    resetWorld()
    const { proposal, outcome } = submitProposal(WS, { kind: 'build', raw: blueprint(), request: 'x', intent: 'new_build' })
    expect(outcome.report.errors).toEqual([])
    const r = applyProposal(proposal.id) as { ok: boolean; workspaceId?: string }
    expect(r.ok).toBe(true)
    expect(r.workspaceId).toBeTruthy()
    expect(r.workspaceId).not.toBe(WS)
    const mods = useModuleStore.getState().modules
    expect(mods.some((m) => m.workspaceId === WS)).toBe(false)
    expect(mods.filter((m) => m.workspaceId === r.workspaceId).length).toBeGreaterThan(3)
    const nw = useWorkspaceStore.getState().workspaces.find((w) => w.id === r.workspaceId)!
    expect(nw.blank).toBe(true)
    expect(nw.kind).toBe('project')
    // publishing does not switch away from where the user was; they open the project from My projects
    expect(useWorkspaceStore.getState().currentId).not.toBe(r.workspaceId)
    expect(mods.filter((m) => m.workspaceId === r.workspaceId).every((m) => m.icon && m.icon !== 'Box')).toBe(true)
  })
})
