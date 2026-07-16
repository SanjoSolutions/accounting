import 'server-only'
import { createDocument } from '@/server'
import { getCurrentUser } from '@/server/authentication'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  if (!await getCurrentUser(request.headers)) {
    return Response.json({ success: false }, { status: 401 })
  }
  const document = await createDocument(await request.json())
  return Response.json({ success: true, data: document })
}
