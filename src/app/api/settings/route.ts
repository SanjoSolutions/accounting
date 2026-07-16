import 'server-only'
import { updateSettings } from '@/server'

export const runtime = 'nodejs'

export async function PUT(request: Request) {
  await updateSettings(await request.json())
  return Response.json({ success: true })
}
