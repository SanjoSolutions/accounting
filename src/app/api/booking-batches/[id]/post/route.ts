import 'server-only'

import { getCurrentUser } from '@/server/authentication'
import { forbiddenUnless } from '@/server/authorization'
import { bookingBatchError, postBookingBatch } from '@/server/bookingBatches'

export const runtime = 'nodejs'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  const forbidden = forbiddenUnless(user, 'write'); if (forbidden) return forbidden
  try {
    // Posting needs no client payload. If one is supplied, only its audit
    // reason is accepted by the domain helper.
    const raw = await request.text()
    const body = raw.trim() ? JSON.parse(raw) : undefined
    return Response.json(await postBookingBatch(user.id, user.actorId, (await params).id, body))
  } catch (error) {
    return bookingBatchError(error)
  }
}

