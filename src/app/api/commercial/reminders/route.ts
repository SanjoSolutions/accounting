import 'server-only'
import { getCurrentUser } from '@/server/authentication'
import { forbiddenUnless } from '@/server/authorization'
import { commercialApiError, requireObject } from '@/server/commercialApi'
import { issueReceivablesReminder, listReceivablesReminders, type IssueReminderInput } from '@/server/receivablesReminderRepository'

export async function GET(request: Request) {
  const user = await getCurrentUser(request.headers); if (!user) return Response.json({ success: false }, { status: 401 })
  return Response.json({ success: true, data: await listReceivablesReminders(user.id) })
}
export async function POST(request: Request) {
  const user = await getCurrentUser(request.headers); if (!user) return Response.json({ success: false }, { status: 401 })
  const forbidden = forbiddenUnless(user, 'write'); if (forbidden) return forbidden
  try {
    const body = requireObject(await request.json()) as unknown as IssueReminderInput & { requestKey: string }
    return Response.json({ success: true, data: await issueReceivablesReminder(user.id, user.actorId, body.requestKey, body) }, { status: 201 })
  } catch (error) { return commercialApiError(error) }
}
