import 'server-only'
import { getCurrentUser } from '@/server/authentication'
import { getEricReadiness } from '@/server/eric'
import { ensureLedger, getEBalanceSubmissionHistory } from '@/server/ledger'

export async function GET(request: Request, { params }: { params: Promise<{ year: string }> }) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  const year = Number((await params).year)
  if (!Number.isInteger(year)) return Response.json({ success: false, issues: ['Ungültiges Geschäftsjahr.'] }, { status: 400 })
  const idempotencyKey = new URL(request.url).searchParams.get('idempotencyKey') ?? undefined
  try {
    const [readiness, fiscalYear, history] = await Promise.all([
      getEricReadiness(), ensureLedger(user.id, year), getEBalanceSubmissionHistory(user.id, year, idempotencyKey),
    ])
    return Response.json({ success: true, readiness, fiscalYearStatus: fiscalYear.status, history })
  } catch {
    return Response.json({ success: false }, { status: 500 })
  }
}
