import 'server-only'

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { authenticate, type CurrentUser } from '@/authenticationPolicy'
import { getAuthMode } from './auth-mode'

export type { CurrentUser } from '@/authenticationPolicy'

export async function getCurrentUser(requestHeaders: Headers): Promise<CurrentUser | null> {
  return authenticate(getAuthMode(), async () => {
    const { auth } = await import('./auth')
    const session = await auth.api.getSession({ headers: requestHeaders })
    if (!session) return null

    return {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
    }
  })
}

export async function requirePageUser(): Promise<CurrentUser> {
  const user = await getCurrentUser(await headers())
  if (!user) redirect('/sign-in')
  return user
}
