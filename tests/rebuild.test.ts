import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { projectIdFor } from '#/genius/compiler/ids'
import { acceptProposal, submitProposal } from '#/genius/service/builder'
import { useModuleStore } from '#/stores/moduleStore'
import { resetWorld, TENANT, WS } from './helpers'
const load = () => {
  const bp = JSON.parse(readFileSync(new URL('./fixtures/ai-letting-blueprint.json', import.meta.url), 'utf8'))
  bp.meta.projectId = projectIdFor(TENANT, WS); bp.meta.revisionId = 'rev_none'
  for (const r of bp.relationships) r.deletePolicy = 'restrict'
  for (const r of bp.roles) r.grants = r.grants.filter((g: string) => g !== 'accessSettings')
  return bp
}
describe('rebuilding after the modules were deleted', () => {
  it('commits the same AI blueprint three times in a row (stale forms, views, dashboards and roles stay behind)', () => {
    resetWorld()
    for (let i = 0; i < 3; i++) {
      const { proposal, outcome } = submitProposal(WS, { kind: 'build', raw: load() as never, request: 'x' + i, intent: 'new_build' })
      expect(outcome.report.errors).toEqual([])
      const r = acceptProposal(proposal.id)
      expect(r).toMatchObject({ ok: true })
      useModuleStore.getState().removeByWorkspace(WS)
    }
  })
})
