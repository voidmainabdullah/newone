import { createFileRoute } from '@tanstack/react-router'
import { AuthPage } from '#/pages/AuthPage'

export const Route = createFileRoute('/signup')({
  head: () => ({ meta: [{ title: 'Create account · Blitcrm' }] }),
  component: () => <AuthPage mode="signup" />,
})
