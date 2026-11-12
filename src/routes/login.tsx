import { createFileRoute } from '@tanstack/react-router'
import { AuthPage } from '#/pages/AuthPage'

export const Route = createFileRoute('/login')({
  head: () => ({ meta: [{ title: 'Sign in · Blitcrm' }] }),
  component: () => <AuthPage mode="login" />,
})
