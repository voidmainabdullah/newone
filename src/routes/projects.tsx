import { createFileRoute } from '@tanstack/react-router'
import { ProjectsPage } from '#/pages/ProjectsPage'

export const Route = createFileRoute('/projects')({
  head: () => ({ meta: [{ title: 'My projects · Blitcrm' }] }),
  component: ProjectsPage,
})
