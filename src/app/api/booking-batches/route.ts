import 'server-only'

import { getCurrentUser } from '@/server/authentication'
import { bookingBatchError, getBookingBatches } from '@/server/bookingBatches'

export const runtime = 'nodejs'

/** Returns the tenant-scoped editable batches and account choices for a fiscal year. */
export async function GET(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  const year = new URL(request.url).searchParams.get('year')
  try {
    return Response.json(await getBookingBatches(user.id, year))
  } catch (error) {
    return bookingBatchError(error)
  }
}
