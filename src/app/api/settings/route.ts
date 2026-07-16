import 'server-only'
import { getSettings, updateSettings } from '@/server'
import { getCurrentUser } from '@/server/authentication'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  if (!await getCurrentUser(request.headers)) {
    return Response.json({ success: false }, { status: 401 })
  }
  const settings = await getSettings()
  return Response.json({ success: true, data: settings })
}

export async function PUT(request: Request) {
  if (!await getCurrentUser(request.headers)) {
    return Response.json({ success: false }, { status: 401 })
  }
  await updateSettings(await request.json())
  return Response.json({ success: true })
}
