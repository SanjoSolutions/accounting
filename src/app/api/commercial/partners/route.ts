import 'server-only'
import { getCurrentUser } from '@/server/authentication'
import { forbiddenUnless } from '@/server/authorization'
import { commercialApiError, requireObject } from '@/server/commercialApi'
import { createBusinessPartner, listBusinessPartners, type BusinessPartnerInput } from '@/server/commercialAccountingRepository'

export async function GET(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  return Response.json({ success: true, data: await listBusinessPartners(user.id) })
}

export async function POST(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  const forbidden = forbiddenUnless(user, 'write'); if (forbidden) return forbidden
  try {
    const input = requireObject(await request.json()) as unknown as BusinessPartnerInput
    return Response.json({ success: true, data: await createBusinessPartner(user.id, user.actorId ?? user.id, input) }, { status: 201 })
  } catch (error) { return commercialApiError(error) }
}
