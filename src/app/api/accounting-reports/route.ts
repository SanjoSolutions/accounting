import 'server-only'

import { getCurrentUser } from '@/server/authentication'
import {
  AccountingReportInvalidSetupError,
  AccountingReportNotFoundError,
  getAccountingReport,
} from '@/server/accountingReports'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false, error: 'Authentication required.' }, { status: 401 })

  const rawYear = new URL(request.url).searchParams.get('year')
  const year = rawYear === null || !/^\d{4}$/.test(rawYear) ? Number.NaN : Number(rawYear)
  if (!Number.isInteger(year) || year < 1900 || year > 2200) {
    return Response.json({ success: false, error: 'year must be an integer from 1900 through 2200.' }, { status: 400 })
  }

  try {
    return Response.json(await getAccountingReport(user.id, year))
  } catch (error) {
    if (error instanceof AccountingReportNotFoundError) {
      return Response.json({ success: false, error: error.message }, { status: 404 })
    }
    if (error instanceof AccountingReportInvalidSetupError) {
      return Response.json({ success: false, error: error.message, issues: error.issues }, { status: 400 })
    }
    throw error
  }
}
