import { createFileRoute } from '@tanstack/react-router'
import { RecentPage } from '#/pages/RecentFavouritesPages'

export const Route = createFileRoute('/recent')({
  head: () => ({ meta: [{ title: 'Recent · Blitcrm' }] }),
  component: RecentPage,
})
