import { createFileRoute } from '@tanstack/react-router'
import { ToolsPage } from '#/pages/ToolsPage'

export const Route = createFileRoute('/tools')({
  head: () => ({ meta: [{ title: 'Tools · Blitcrm' }] }),
  component: ToolsPage,
})
