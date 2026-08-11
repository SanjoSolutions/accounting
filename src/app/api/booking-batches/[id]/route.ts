import 'server-only'

import { getCurrentUser } from '@/server/authentication'
import { forbiddenUnless } from '@/server/authorization'
import { bookingBatchError, publicBookingBatchDraft, reviseBookingBatch } from '@/server/bookingBatches'

export const runtime = 'nodejs'

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  const forbidden = forbiddenUnless(user, 'write'); if (forbidden) return forbidden
  try {
    const body = await request.json()
    const draft = await reviseBookingBatch(user.id, user.actorId, (await params).id, body)
    return Response.json(publicBookingBatchDraft(draft))
  } catch (error) {
    return bookingBatchError(error)
  }
}
