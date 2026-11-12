import { createFileRoute } from '@tanstack/react-router'
import { FavouritesPage } from '#/pages/RecentFavouritesPages'

export const Route = createFileRoute('/favourites')({
  head: () => ({ meta: [{ title: 'Favourites · Blitcrm' }] }),
  component: FavouritesPage,
})
