import 'server-only'
import { AccountingValidationError } from '@/core/doubleEntry'
import { parseEBalanceMasterData } from '@/core/eBilanz'
import { getCurrentUser } from '@/server/authentication'
import { exportEBalance } from '@/server/ledger'

export async function POST(request: Request, { params }: { params: Promise<{ year: string }> }) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  const year = Number((await params).year)
  try {
    const body: unknown = await request.json()
    const masterData = parseEBalanceMasterData(body)
    const archive = await exportEBalance(user.id, year, masterData)
    return new Response(Buffer.from(archive), {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="e-bilanz-${year}-pruefpaket.zip"`,
      },
    })
  } catch (error) {
    if (error instanceof AccountingValidationError || error instanceof SyntaxError) {
      return Response.json({ success: false, issues: error instanceof AccountingValidationError ? error.issues : ['Der Anfrageinhalt ist kein gültiges JSON.'] }, { status: 400 })
    }
    return Response.json({ success: false }, { status: 500 })
  }
}
