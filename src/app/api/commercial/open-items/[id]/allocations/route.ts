import 'server-only'
import { getCurrentUser } from '@/server/authentication'
import { forbiddenUnless } from '@/server/authorization'
import { commercialApiError, requireObject } from '@/server/commercialApi'
import { allocateSettlement } from '@/server/commercialAccountingRepository'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  const forbidden = forbiddenUnless(user, 'write'); if (forbidden) return forbidden
  try {
    const body = requireObject(await request.json())
    const requestKey = request.headers.get('idempotency-key') ?? ''
    return Response.json({ success: true, data: await allocateSettlement(user.id, user.actorId ?? user.id, requestKey, { ...body, openItemId: (await params).id } as unknown as Parameters<typeof allocateSettlement>[3]) }, { status: 201 })
  } catch (error) { return commercialApiError(error) }
}
