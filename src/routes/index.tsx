import { createFileRoute, redirect } from '@tanstack/react-router'

// Blitcrm always opens in Genius AI.
export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({ to: '/genius', replace: true })
  },
})
