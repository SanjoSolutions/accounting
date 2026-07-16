import 'server-only'
import { createBookingRecord } from '@/server'
import { getCurrentUser } from '@/server/authentication'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  if (!await getCurrentUser(request.headers)) {
    return Response.json({ success: false }, { status: 401 })
  }
  await createBookingRecord(await request.json())
  return Response.json({ success: true })
}
