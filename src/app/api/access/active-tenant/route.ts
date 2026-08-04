import 'server-only'

import { getCurrentUser } from '@/server/authentication'
import { listAvailableTenants } from '@/server/tenantAccess'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  let body: Record<string, unknown>
  try { body = await request.json() as Record<string, unknown> } catch { return Response.json({ success: false, error: 'Invalid JSON body.' }, { status: 400 }) }
  if (typeof body.ownerId !== 'string') return Response.json({ success: false, error: 'ownerId is required' }, { status: 400 })
  const allowed = (await listAvailableTenants(user.actorId)).some(item => item.ownerId === body.ownerId)
  if (!allowed) return Response.json({ success: false, error: 'Tenant access is not permitted.' }, { status: 403 })
  const response = Response.json({ success: true })
  response.headers.append('set-cookie', `accounting-tenant=${encodeURIComponent(body.ownerId)}; Path=/; HttpOnly; SameSite=Lax`)
  return response
}
