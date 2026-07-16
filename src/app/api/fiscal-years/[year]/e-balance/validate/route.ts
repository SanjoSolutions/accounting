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
    const masterData = parseEBalanceMasterData(await request.json())
    const result = await processEBalanceWithEric(user.id, year, masterData, { send: false })
    return Response.json({ success: true, statusCode: result.statusCode, statusText: result.statusText })
  } catch (error) {
    if (error instanceof AccountingValidationError || error instanceof SyntaxError) return Response.json({ success: false, issues: error instanceof AccountingValidationError ? error.issues : ['Der Anfrageinhalt ist kein gültiges JSON.'] }, { status: 400 })
    return Response.json({ success: false }, { status: 500 })
  }
}
