import 'server-only'

import { getCurrentUser } from '@/server/authentication'
import { importDatev } from '@/server/datevImport'
import { AccountingValidationError } from '@/core/doubleEntry'

export const runtime = 'nodejs'
const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_TOTAL_BYTES = 25 * 1024 * 1024
const MAX_FILES = 20
const MAX_REQUEST_BYTES = MAX_TOTAL_BYTES + 1024 * 1024

export async function POST(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  try {
    const contentLength = Number(request.headers.get('content-length') ?? 0)
    if (contentLength > MAX_REQUEST_BYTES) throw new AccountingValidationError(['Der DATEV-Upload ist zu groß.'])
    const form = await (await readLimitedBody(request, MAX_REQUEST_BYTES)).formData()
    const uploads = form.getAll('files').filter((entry): entry is File => typeof entry !== 'string')
    if (uploads.length === 0 || uploads.length > MAX_FILES) throw new AccountingValidationError([`Bitte wählen Sie 1 bis ${MAX_FILES} DATEV-CSV-Dateien aus.`])
    if (uploads.some(file => file.size > MAX_FILE_BYTES) || uploads.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL_BYTES) {
      throw new AccountingValidationError(['Der DATEV-Upload ist zu groß. Pro Datei sind 10 MB, insgesamt 25 MB erlaubt.'])
    }
    const files = await Promise.all(uploads.map(async file => ({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })))
    return Response.json(await importDatev(user.id, files), { status: 201 })
  } catch (error) {
    if (error instanceof AccountingValidationError) return Response.json({ success: false, issues: error.issues }, { status: 400 })
    return Response.json({ success: false, issues: ['Der DATEV-Import konnte nicht verarbeitet werden.'] }, { status: 500 })
  }
}

export async function readLimitedBody(request: Request, maximumBytes: number) {
  if (!request.body) return request
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maximumBytes) {
      await reader.cancel()
      throw new AccountingValidationError(['Der DATEV-Upload ist zu groß.'])
    }
    chunks.push(value)
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
  const headers = new Headers(request.headers)
  headers.delete('content-length')
  return new Request(request.url, { method: request.method, headers, body })
}
