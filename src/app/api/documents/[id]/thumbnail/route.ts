import 'server-only'

import { readDocumentThumbnail } from '@/server'
import { getCurrentUser } from '@/server/authentication'

export const runtime = 'nodejs'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })

  const { id } = await params
  const thumbnail = await readDocumentThumbnail(id, user.id)
  if (!thumbnail) return Response.json({ success: false }, { status: 404 })

  return new Response(new Uint8Array(thumbnail.content), {
    headers: {
      'Content-Type': thumbnail.contentType,
      'Content-Length': String(thumbnail.content.length),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
