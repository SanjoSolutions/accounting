import 'server-only'
import { AccountingValidationError } from '@/core/doubleEntry'
import { parseEBalanceMasterData } from '@/core/eBilanz'
import { getCurrentUser } from '@/server/authentication'
import { processEBalanceWithEric } from '@/server/ledger'

export async function POST(request: Request, { params }: { params: Promise<{ year: string }> }) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  try {
    const year = Number((await params).year)
    const body: unknown = await request.json()
    if (!body || typeof body !== 'object') throw new AccountingValidationError(['E-Bilanz-Stammdaten fehlen.'])
    const masterData = parseEBalanceMasterData(body)
    const { pin, confirmed, idempotencyKey } = body as Record<string, unknown>
    if (typeof pin !== 'string' || !pin) throw new AccountingValidationError(['Die Zertifikats-PIN ist erforderlich.'])
    if (confirmed !== true) throw new AccountingValidationError(['Bestätigen Sie die verbindliche Übermittlung ausdrücklich.'])
    if (typeof idempotencyKey !== 'string') throw new AccountingValidationError(['Der Idempotenzschlüssel fehlt.'])
    const result = await processEBalanceWithEric(user.id, year, masterData, { send: true, pin, confirmed, idempotencyKey })
    if (!result.sent) return Response.json({ success: false, sent: false, issues: [result.statusText || 'ERiC hat den Datensatz nicht übermittelt.'] }, { status: 422 })
    return Response.json({ success: true, statusCode: result.statusCode, statusText: result.statusText, sent: result.sent })
  } catch (error) {
    if (error instanceof AccountingValidationError || error instanceof SyntaxError) return Response.json({ success: false, issues: error instanceof AccountingValidationError ? error.issues : ['Der Anfrageinhalt ist kein gültiges JSON.'] }, { status: 400 })
    return Response.json({ success: false }, { status: 500 })
  }
}
