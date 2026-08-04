import 'server-only'
import { getCurrentUser } from '@/server/authentication'
import { forbiddenUnless } from '@/server/authorization'
import { commercialApiError, requireObject } from '@/server/commercialApi'
import { cancelReceivablesReminder } from '@/server/receivablesReminderRepository'

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser(request.headers); if (!user) return Response.json({ success: false }, { status: 401 })
  const forbidden = forbiddenUnless(user, 'write'); if (forbidden) return forbidden
  try {
    const body = requireObject(await request.json()) as { requestKey: string; cancelledOn: string; reason: string }
    const { id } = await context.params
    return Response.json({ success: true, data: await cancelReceivablesReminder(user.id, user.actorId, id, body.requestKey, body) }, { status: 201 })
  } catch (error) { return commercialApiError(error) }
}
