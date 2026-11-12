import { createFileRoute } from '@tanstack/react-router'
import { ModulesPage } from '#/pages/ModulesPage'

export const Route = createFileRoute('/modules')({
  head: () => ({ meta: [{ title: 'All Modules · Blitcrm' }] }),
  component: ModulesPage,
})
