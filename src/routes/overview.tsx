import { createFileRoute } from '@tanstack/react-router'
import { OverviewPage } from '#/pages/OverviewPage'

export const Route = createFileRoute('/overview')({
  head: () => ({ meta: [{ title: 'Overview · Blitcrm' }] }),
  component: OverviewPage,
})
