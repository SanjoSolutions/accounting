import 'server-only'
import { AccountingValidationError } from '@/core/doubleEntry'
import { getCurrentUser } from '@/server/authentication'
import { closeFiscalYear } from '@/server/ledger'

export async function POST(request: Request, { params }: { params: Promise<{ year: string }> }) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  const year = Number((await params).year)
  try {
    return Response.json(await closeFiscalYear(user.id, year))
  } catch (error) {
    if (error instanceof AccountingValidationError) {
      return Response.json({ success: false, issues: error.issues }, { status: 400 })
    }
    return Response.json({ success: false }, { status: 500 })
  }
}
