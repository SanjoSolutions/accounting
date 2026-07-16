import 'server-only'
import { createDocument } from '@/server'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  const document = await createDocument(await request.json())
  return Response.json({ success: true, data: document })
}
