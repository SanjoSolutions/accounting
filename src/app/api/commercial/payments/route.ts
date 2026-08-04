import 'server-only'
import { getCurrentUser } from '@/server/authentication'
import { forbiddenUnless } from '@/server/authorization'
import { commercialApiError, requireObject } from '@/server/commercialApi'
import { recordPaymentSettlement } from '@/server/commercialAccountingRepository'

export async function POST(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  const forbidden = forbiddenUnless(user, 'write'); if (forbidden) return forbidden
  try {
    const body = requireObject(await request.json())
    return Response.json({ success: true, data: await recordPaymentSettlement(user.id, user.actorId ?? user.id, body as unknown as Parameters<typeof recordPaymentSettlement>[2]) }, { status: 201 })
  } catch (error) { return commercialApiError(error) }
}
