import { createFileRoute } from '@tanstack/react-router'
import { HistoryPage } from '#/pages/HistoryPage'

export const Route = createFileRoute('/history')({
  head: () => ({ meta: [{ title: 'History · Blitcrm' }] }),
  component: HistoryPage,
})
