import type { ID, Template, Workspace } from '#/types'
import { useWorkspaceStore } from '#/stores/workspaceStore'
import { useSettingsStore } from '#/stores/settingsStore'
import { useModuleStore } from '#/stores/moduleStore'
import { useRecordStore } from '#/stores/recordStore'
import { useActivityStore, logActivity } from '#/stores/activityStore'
import { useFormStore, useViewStore, useDashboardStore, useWorkflowStore, useRunStore, useDataFlowStore } from '#/stores/collections'
import { useEngineStore } from '#/stores/engineStore'
import { ensureDefaultDashboard } from '#/engine/defaultDashboard'
import { installTemplate } from './installer'
import { NAV_REV, buildDefaultNav } from './navService'

/**
 * A workspace starts with NO modules and an empty navigation: the tools live in the sidebar's Tools section and every
 * module is added by the user, by a template they chose, or by Blitcrm Studio. Only an explicit template installs anything.
 */
export function bootstrapWorkspace(ws: ID, template?: Template | null) {
  useSettingsStore.getState().setNav(ws, buildDefaultNav())
  if (template) installTemplate(template, { workspaceId: ws, navParentLabel: template.category, silent: true })
  // every project (blank, template, Studio-built, first workspace) starts with an "Overview" dashboard config
  ensureDefaultDashboard(ws)
}

/** The home workspace is the account's main one; it never receives an AI-built CRM (those become projects). */
export const isHomeWorkspace = (w: Workspace, all: Workspace[]): boolean => w.kind === 'home' || (!w.kind && all[0]?.id === w.id)
export const isProjectWorkspace = (w: Workspace, all: Workspace[]): boolean => !isHomeWorkspace(w, all)

export interface CreateWorkspaceInput {
  name: string
  description?: string
  icon?: string
  color?: string
  kind?: 'home' | 'project'
  /** install this template into the new workspace; omitted = start blank */
  template?: Template | null
  /** keep the previously open workspace current (used when creating one on someone's behalf) */
  switchTo?: boolean
}

export function createWorkspace(input: CreateWorkspaceInput): Workspace {
  const kind = input.kind ?? 'project'
  const ws = useWorkspaceStore.getState().add({ name: input.name.trim() || 'Untitled project', description: input.description, icon: input.icon ?? 'Briefcase', color: input.color ?? '#8ab4f8', blank: kind === 'project' ? true : undefined, kind, navRev: NAV_REV })
  bootstrapWorkspace(ws.id, input.template)
  if (input.switchTo !== false) useWorkspaceStore.getState().setCurrent(ws.id)
  logActivity({ workspaceId: ws.id, action: 'workspace_created', entity: 'workspace', description: `Created ${kind === 'home' ? 'workspace' : 'project'} "${ws.name}"` })
  return ws
}

export function renameWorkspace(id: ID, patch: Partial<Pick<Workspace, 'name' | 'description' | 'icon' | 'color'>>) {
  useWorkspaceStore.getState().update(id, patch)
}

export function deleteWorkspace(id: ID): boolean {
  const st = useWorkspaceStore.getState()
  if (st.workspaces.length <= 1) return false
  const recIds = useRecordStore.getState().records.filter((r) => r.workspaceId === id).map((r) => r.id)
  useRecordStore.getState().purge(recIds)
  useRecordStore.getState().removeByWorkspace(id)
  useModuleStore.getState().removeByWorkspace(id)
  useFormStore.getState().removeByWorkspace(id)
  useViewStore.getState().removeByWorkspace(id)
  useDashboardStore.getState().removeByWorkspace(id)
  useWorkflowStore.getState().removeByWorkspace(id)
  useDataFlowStore.getState().removeByWorkspace(id)
  useRunStore.getState().removeByWorkspace(id)
  useEngineStore.getState().removeByWorkspace(id)
  useActivityStore.getState().clearWorkspace(id)
  useSettingsStore.getState().removeWorkspaceData(id)
  st.remove(id)
  return true
}
