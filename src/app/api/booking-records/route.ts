import 'server-only'
import { getCurrentUser } from '@/server/authentication'
import { AccountingValidationError } from '@/core/doubleEntry'
import { getLedgerWorkspace, postJournalEntry } from '@/server/ledger'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  const year = Number(new URL(request.url).searchParams.get('year') ?? new Date().getFullYear())
  try {
    return Response.json(await getLedgerWorkspace(user.id, year))
  } catch (error) {
    return accountingError(error)
  }
}

export async function POST(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  try {
    const entry = await postJournalEntry(user.id, await request.json())
    return Response.json(entry, { status: 201 })
  } catch (error) {
    return accountingError(error)
  }
}

function accountingError(error: unknown) {
  if (error instanceof AccountingValidationError) {
    return Response.json({ success: false, issues: error.issues }, { status: 400 })
  }
  if (error instanceof SyntaxError) {
    return Response.json({ success: false, issues: ['Der Anfrageinhalt ist kein gültiges JSON.'] }, { status: 400 })
  }
  return Response.json({ success: false, issues: ['Die Buchung konnte nicht verarbeitet werden.'] }, { status: 500 })
}
