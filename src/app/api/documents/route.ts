import 'server-only'

import {
  createDocument,
  DocumentUploadError,
  getMaxDocumentUploadBytes,
} from '@/server'
import { getCurrentUser } from '@/server/authentication'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) {
    return Response.json({ success: false }, { status: 401 })
  }

  try {
    const content = await readDocumentBody(request, getMaxDocumentUploadBytes())
    const document = await createDocument({
      content,
      contentType: request.headers.get('content-type') || '',
      fileName: getFileName(request.headers),
    }, user.id)
    return Response.json({ success: true, data: document }, { status: 201 })
  } catch (error) {
    if (error instanceof DocumentUploadError) {
      return Response.json({ success: false, error: error.message }, { status: 400 })
    }
    throw error
  }
}

async function readDocumentBody(request: Request, maxBytes: number): Promise<Buffer> {
  const declaredSize = Number(request.headers.get('content-length'))
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
    throw new DocumentUploadError(`The document exceeds ${ maxBytes } bytes`)
  }
  if (!request.body) throw new DocumentUploadError('A document file is required')

  const reader = request.body.getReader()
  const chunks: Buffer[] = []
  let size = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      throw new DocumentUploadError(`The document exceeds ${ maxBytes } bytes`)
    }
    chunks.push(Buffer.from(value))
  }

  return Buffer.concat(chunks, size)
}

function getFileName(headers: Headers): string {
  const encodedName = headers.get('x-document-file-name')
  if (!encodedName) return 'document.pdf'

  try {
    return decodeURIComponent(encodedName)
  } catch {
    throw new DocumentUploadError('The document file name is invalid')
  }
}
