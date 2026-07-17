import 'server-only'
import { isChartOfAccountsStandard } from '@/core/ChartOfAccounts'
import { getSettings, updateSettings } from '@/server'
import { getCurrentUser } from '@/server/authentication'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  if (!await getCurrentUser(request.headers)) {
    return Response.json({ success: false }, { status: 401 })
  }
  const settings = await getSettings()
  return Response.json({ success: true, data: settings })
}

export async function PUT(request: Request) {
  if (!await getCurrentUser(request.headers)) {
    return Response.json({ success: false }, { status: 401 })
  }
  const data = await request.json()
  if (data.chartOfAccounts !== undefined && !isChartOfAccountsStandard(data.chartOfAccounts)) {
    return Response.json(
      { success: false, error: 'chartOfAccounts must be SKR03 or SKR04' },
      { status: 400 },
    )
  }
  await updateSettings(data)
  return Response.json({ success: true })
}
