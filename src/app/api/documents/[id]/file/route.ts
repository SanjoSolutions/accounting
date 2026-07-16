import 'server-only'

import { readDocumentFile } from '@/server'
import { getCurrentUser } from '@/server/authentication'

export const runtime = 'nodejs'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser(request.headers)
  if (!user) {
    return Response.json({ success: false }, { status: 401 })
  }
  const { id } = await params
  const file = await readDocumentFile(id, user.id)
  if (!file) {
    return Response.json({ success: false }, { status: 404 })
  }

  return new Response(new Uint8Array(file.content), {
    headers: {
      'Content-Type': file.contentType,
      'Content-Length': String(file.content.length),
      'Content-Disposition': `inline; filename="${ sanitizeHeaderValue(file.fileName) }"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/["\\\r\n]/g, '_')
}
