import 'server-only'
import { isChartOfAccountsStandard } from '@/core/ChartOfAccounts'
import { getSettings, updateSettings } from '@/server'
import { CompanyProfileValidationError, deriveReportApplicability, validateCompanyProfile } from '@/server/compliance/companyProfile'
import { getCurrentUser } from '@/server/authentication'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) {
    return Response.json({ success: false }, { status: 401 })
  }
  const settings = await getSettings(user.id)
  const profile = settings.companyProfile
  const reportApplicability = profile && validateCompanyProfile(profile).length === 0 ? deriveReportApplicability(profile) : null
  return Response.json({ success: true, data: { ...settings, reportApplicability } })
}

export async function PUT(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) {
    return Response.json({ success: false }, { status: 401 })
  }
  const data = await request.json()
  if (data.chartOfAccounts !== undefined && !isChartOfAccountsStandard(data.chartOfAccounts)) {
    return Response.json(
      { success: false, error: 'chartOfAccounts must be SKR03 or SKR04' },
      { status: 400 },
    )
  }
  try { await updateSettings(data, user.id, user.id) }
  catch (error) {
    if (error instanceof CompanyProfileValidationError) return Response.json({ success: false, error: error.message }, { status: 400 })
    throw error
  }
  return Response.json({ success: true })
}
