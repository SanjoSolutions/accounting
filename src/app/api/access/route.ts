import 'server-only'

import { getCurrentUser } from '@/server/authentication'
import { forbiddenUnless } from '@/server/authorization'
import { listAvailableTenants, listTenantAccess, removeTenantMember, setTenantMember, TenantAccessError } from '@/server/tenantAccess'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  return Response.json({ success: true, data: { ...(await listTenantAccess(user)), tenants: await listAvailableTenants(user.actorId) } })
}

export async function POST(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  const forbidden = forbiddenUnless(user, 'manage_access')
  if (forbidden) return forbidden
  try {
    const body = await request.json() as Record<string, unknown>
    const data = body.action === 'remove'
      ? await removeTenantMember(user.id, user.actorId, body.userId, body.reason)
      : await setTenantMember(user.id, user.actorId, body.email, body.role, body.reason)
    return Response.json({ success: true, data })
  } catch (error) { return accessError(error) }
}

function accessError(error: unknown) {
  if (error instanceof TenantAccessError) return Response.json({ success: false, error: error.message }, { status: error.status })
  if (error instanceof SyntaxError) return Response.json({ success: false, error: 'Invalid JSON body.' }, { status: 400 })
  throw error
}
