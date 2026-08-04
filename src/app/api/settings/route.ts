import 'server-only'
import { isChartOfAccountsStandard } from '@/core/ChartOfAccounts'
import { getSettings, updateSettings } from '@/server'
import { CompanyProfileValidationError, deriveReportApplicability, validateCompanyProfile } from '@/server/compliance/companyProfile'
import { getCurrentUser } from '@/server/authentication'
import { forbiddenUnless } from '@/server/authorization'
import { parseIncomingReverseChargeAccounts } from '@/core/incomingReverseCharge'

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
  const forbidden = forbiddenUnless(user, 'write'); if (forbidden) return forbidden
  let data: Record<string, unknown>
  try { data = await request.json() }
  catch (error) {
    if (error instanceof SyntaxError) return Response.json({ success: false, error: 'Invalid JSON body.' }, { status: 400 })
    throw error
  }
  if (data.chartOfAccounts !== undefined && !isChartOfAccountsStandard(data.chartOfAccounts)) {
    return Response.json(
      { success: false, error: 'chartOfAccounts must be SKR03 or SKR04' },
      { status: 400 },
    )
  }
  try { if (data.incomingReverseChargeAccounts !== undefined) parseIncomingReverseChargeAccounts(data.incomingReverseChargeAccounts) }
  catch (error) { return Response.json({ success: false, error: error instanceof Error ? error.message : 'Invalid incoming §13b configuration.' }, { status: 400 }) }
  try { await updateSettings(data, user.id, user.actorId ?? user.id) }
  catch (error) {
    if (error instanceof CompanyProfileValidationError) return Response.json({ success: false, error: error.message }, { status: 400 })
    throw error
  }
  return Response.json({ success: true })
}
