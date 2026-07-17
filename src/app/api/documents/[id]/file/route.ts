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
      'Content-Disposition': documentContentDisposition(file.contentType, file.fileName),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

export function documentContentDisposition(contentType: string, fileName: string) {
  const inlineTypes = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/bmp', 'image/tiff', 'image/webp'])
  const disposition = inlineTypes.has(contentType.toLowerCase()) ? 'inline' : 'attachment'
  return `${disposition}; filename="${sanitizeHeaderValue(fileName)}"`
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/["\\\r\n]/g, '_')
}
