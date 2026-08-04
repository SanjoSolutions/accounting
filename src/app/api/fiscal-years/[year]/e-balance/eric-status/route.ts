import 'server-only'
import { getCurrentUser } from '@/server/authentication'
import { getEricReadiness } from '@/server/eric'
import { ensureLedger, getEBalanceSubmissionHistory, getFiscalYearStatus } from '@/server/ledger'

export async function GET(request: Request, { params }: { params: Promise<{ year: string }> }) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  const year = Number((await params).year)
  if (!Number.isInteger(year)) return Response.json({ success: false, issues: ['Ungültiges Geschäftsjahr.'] }, { status: 400 })
  const idempotencyKey = new URL(request.url).searchParams.get('idempotencyKey') ?? undefined
  try {
    const [readiness, fiscalYearStatus, history] = await Promise.all([
      getEricReadiness(),
      user.role === 'READ_ONLY' ? getFiscalYearStatus(user.id, year) : ensureLedger(user.id, year).then(fiscalYear => fiscalYear.status),
      getEBalanceSubmissionHistory(user.id, year, idempotencyKey),
    ])
    return Response.json({ success: true, readiness, fiscalYearStatus, history })
  } catch {
    return Response.json({ success: false }, { status: 500 })
  }
}
