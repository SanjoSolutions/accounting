import 'server-only'

import { AccountingValidationError } from '@/core/doubleEntry'
import { isLexwareAuditExport, type LexwareAuditFile } from '@/core/lexwareAudit'
import { getCurrentUser } from '@/server/authentication'
import { importDatev } from '@/server/datevImport'
import { importLexwareAudit } from '@/server/lexwareAuditImport'
import { readLimitedBody } from '@/server/importUpload'

export const runtime = 'nodejs'
const MAX_FILE_BYTES = 25 * 1024 * 1024
const MAX_TOTAL_BYTES = 64 * 1024 * 1024
const MAX_FILES = 5_500
const MAX_REQUEST_BYTES = MAX_TOTAL_BYTES + 2 * 1024 * 1024

export async function POST(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  try {
    const contentLength = Number(request.headers.get('content-length') ?? 0)
    if (contentLength > MAX_REQUEST_BYTES) throw new AccountingValidationError(['Der Importordner ist zu groß.'])
    const form = await (await readLimitedBody(request, MAX_REQUEST_BYTES)).formData()
    const uploads = form.getAll('files').filter((entry): entry is File => typeof entry !== 'string')
    if (uploads.length === 0 || uploads.length > MAX_FILES) {
      throw new AccountingValidationError([`Bitte wählen Sie einen Exportordner mit höchstens ${MAX_FILES} Dateien aus.`])
    }
    if (uploads.some(file => file.size > MAX_FILE_BYTES) || uploads.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL_BYTES) {
      throw new AccountingValidationError(['Der Importordner ist zu groß. Pro Datei sind 25 MB, insgesamt 64 MB erlaubt.'])
    }
    const files: LexwareAuditFile[] = await Promise.all(uploads.map(async file => ({
      name: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    })))
    const hasDatev = files.some(file => file.name.toLowerCase().endsWith('.csv'))
    const hasLexware = isLexwareAuditExport(files)
    if (hasDatev && hasLexware) throw new AccountingValidationError(['Der Ordner enthält gleichzeitig DATEV- und Lexware-Exportdaten. Bitte wählen Sie genau einen Export aus.'])
    if (hasLexware) return Response.json(await importLexwareAudit(user.id, files), { status: 201 })
    if (hasDatev) {
      const imported = await importDatev(user.id, files.filter(file => file.name.toLowerCase().endsWith('.csv')))
      return Response.json({ format: 'DATEV', ...imported, documents: 0, years: imported.years }, { status: 201 })
    }
    throw new AccountingValidationError(['Das Importformat wurde nicht erkannt. Unterstützt werden DATEV EXTF und Lexware Buchhaltung „Daten Betriebsprüfung“.'])
  } catch (error) {
    if (error instanceof AccountingValidationError) return Response.json({ success: false, issues: error.issues }, { status: 400 })
    console.error('Accounting import failed', error)
    return Response.json({ success: false, issues: ['Der Buchhaltungsimport konnte nicht verarbeitet werden.'] }, { status: 500 })
  }
}
