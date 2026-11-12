import { useEffect, useState } from 'react'
import type { Workspace } from '#/types'
import { Modal } from '#/components/ui/Modal'
import { Button } from '#/components/ui/Button'
import { Field, Input, Textarea } from '#/components/ui/controls'
import { ColorPicker, IconPicker } from '#/components/ui/Overlays'
import { createWorkspace, renameWorkspace } from '#/services/workspaceService'
import { STARTER_TEMPLATES } from '#/services/onboarding'
import { toast } from '#/utils/toast'
import { StartChooser } from './StartChooser'
import { useGo } from './AppLink'

/** New project (blank by default, or from a template) and the edit dialog for an existing project. */
export function WorkspaceDialog({ open, onClose, workspace }: { open: boolean; onClose: () => void; workspace?: Workspace }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [icon, setIcon] = useState('Briefcase')
  const [color, setColor] = useState('#1a73e8')
  const [start, setStart] = useState<string | null>(null)
  const go = useGo()

  useEffect(() => {
    if (!open) return
    setName(workspace?.name ?? '')
    setDescription(workspace?.description ?? '')
    setIcon(workspace?.icon ?? 'Briefcase')
    setColor(workspace?.color ?? '#1a73e8')
    setStart(null)
  }, [open, workspace])

  const submit = () => {
    if (!name.trim()) return
    if (workspace) {
      renameWorkspace(workspace.id, { name: name.trim(), description, icon, color })
      toast.success('Project updated')
    } else {
      const template = start ? (STARTER_TEMPLATES.find((t) => t.id === start) ?? null) : null
      createWorkspace({ name, description, icon, color, kind: 'project', template })
      toast.success('Project created', template ? `Started from the ${template.name} template.` : 'It starts blank. Describe it in Studio to build it.')
      go(template ? '/' : '/genius')
    }
    onClose()
  }

  return (
    <Modal open={open} onClose={onClose} title={workspace ? 'Edit project' : 'New project'} description={workspace ? undefined : 'Every project has its own modules, records, dashboards and sidebar.'} size="sm" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit} disabled={!name.trim()}>{workspace ? 'Save' : 'Create project'}</Button></>}>
      <div className="space-y-4">
        <Field label="Name" required><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder="e.g. Academy CRM" /></Field>
        <Field label="Description"><Textarea value={description} onChange={(e) => setDescription(e.target.value)} className="min-h-[60px]" /></Field>
        <div className="flex flex-wrap items-center gap-4">
          <Field label="Icon"><IconPicker value={icon} onChange={setIcon} color={color} /></Field>
          <Field label="Colour"><ColorPicker value={color} onChange={setColor} /></Field>
        </div>
        {!workspace && <StartChooser value={start} onChange={setStart} />}
      </div>
    </Modal>
  )
}
