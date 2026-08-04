import 'server-only'

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { authenticate, type CurrentUser } from '@/authenticationPolicy'
import { getAuthMode } from './auth-mode'
import { prisma } from './persistence/client'

export type { CurrentUser } from '@/authenticationPolicy'

export async function getCurrentUser(requestHeaders: Headers): Promise<CurrentUser | null> {
  const user = await authenticate(getAuthMode(), async () => {
    const { auth } = await import('./auth')
    const session = await auth.api.getSession({ headers: requestHeaders })
    if (!session) return null

    return {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
    }
  })
  if (!user || getAuthMode() === 'none') return user

  const requestedTenant = cookieValue(requestHeaders.get('cookie'), 'accounting-tenant')
  if (!requestedTenant || requestedTenant === user.actorId) return user
  const membership = await prisma.tenantMembership.findUnique({
    where: { ownerId_userId: { ownerId: requestedTenant, userId: user.actorId } },
    select: { role: true },
  })
  if (!membership || !isAccountingRole(membership.role)) return user
  return { ...user, id: requestedTenant, role: membership.role }
}

function cookieValue(cookie: string | null, name: string) {
  const item = cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`))
  if (!item) return null
  try { return decodeURIComponent(item.slice(name.length + 1)) } catch { return null }
}

function isAccountingRole(role: string): role is CurrentUser['role'] {
  return role === 'ADMIN' || role === 'ACCOUNTANT' || role === 'READ_ONLY'
}

export async function requirePageUser(): Promise<CurrentUser> {
  const user = await getCurrentUser(await headers())
  if (!user) redirect('/sign-in')
  return user
}
