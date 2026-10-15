import { AccountingValidationError } from '@/core/doubleEntry'
import { ExternalExportError, MAX_EXTERNAL_EVIDENCE_BYTES, type ExternalEvidenceInput } from './repository'

export const privateHeaders = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
export function externalYear(value: string) {
  if (!/^20\d{2}$/.test(value)) throw new ExternalExportError('Ungültiges Geschäftsjahr.', 400)
  return Number(value)
}
export function assertSameOrigin(request: Request) {
  const origin = request.headers.get('origin')
  const target = new URL(request.url)
  // Next can reconstruct request.url with its internal listening hostname.
  // The browser's Host header identifies the actual requested origin; do not
  // accept an arbitrary forwarded host or relax the scheme/port comparison.
  const host = request.headers.get('host')
  if (host) target.host = host
  if (origin && origin !== target.origin) throw new ExternalExportError('Fremde Herkunft ist für diese Änderung nicht zugelassen.', 403)
}
export function externalError(error: unknown) {
  if (error instanceof ExternalExportError) return Response.json({ error: error.message }, { status: error.status, headers: privateHeaders })
  if (error instanceof AccountingValidationError) return Response.json({ issues: error.issues }, { status: 409, headers: privateHeaders })
  return Response.json({ error: 'Exportdaten konnten nicht sicher verarbeitet werden.' }, { status: 500, headers: privateHeaders })
}
export function externalDownload(result: { content: Uint8Array; fileName: string; contentHash: string; packageHash?: string; sourceStatus?: string }) {
  return new Response(new Uint8Array(result.content), { headers: {
    ...privateHeaders, 'Content-Type': result.fileName.endsWith('.zip') ? 'application/zip' : 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${result.fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
    'Content-Length': String(result.content.byteLength), 'X-Content-SHA256': result.contentHash,
    ...(result.packageHash ? { 'X-Package-SHA256': result.packageHash } : {}),
    ...(result.sourceStatus ? { 'X-Export-Source-Status': result.sourceStatus } : {}),
  } })
}
export async function externalEvidenceForm(request: Request): Promise<ExternalEvidenceInput> {
  const limit = MAX_EXTERNAL_EVIDENCE_BYTES + 64 * 1024
  if (Number(request.headers.get('content-length')) > limit) throw new ExternalExportError('Nachweis ist zu groß.', 413)
  const reader = request.body?.getReader()
  if (!reader) throw new ExternalExportError('Nachweisdatei fehlt.', 400)
  const chunks: Uint8Array[] = []; let total = 0
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break
      total += part.value.byteLength
      if (total > limit) { await reader.cancel(); throw new ExternalExportError('Nachweis ist zu groß.', 413) }
      chunks.push(part.value)
    }
  } finally { reader.releaseLock() }
  let form: FormData
  try { form = await new Response(Buffer.concat(chunks), { headers: { 'Content-Type': request.headers.get('content-type') ?? '' } }).formData() }
  catch { throw new ExternalExportError('Ungültige Nachweisanfrage.', 400) }
  const file = form.get('file')
  if (!(file instanceof File)) throw new ExternalExportError('Nachweisdatei fehlt.', 400)
  return {
    packageHash: String(form.get('packageHash') ?? ''), kind: String(form.get('kind') ?? ''), provider: String(form.get('provider') ?? ''),
    occurredAt: String(form.get('occurredAt') ?? ''), note: String(form.get('note') ?? ''), confirmSource: form.get('confirmSource') === 'true',
    fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()),
  }
}
