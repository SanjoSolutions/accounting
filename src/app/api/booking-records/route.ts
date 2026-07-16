import 'server-only'
import { createBookingRecord } from '@/server'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  await createBookingRecord(await request.json())
  return Response.json({ success: true })
}
