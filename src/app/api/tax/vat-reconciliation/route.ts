import 'server-only'
import { VatValidationError } from '@/core/vatEngine'
import { getCurrentUser } from '@/server/authentication'
import { prepareReconciledVatDataset, reconcileTenantVat } from '@/server/tax/vatRepository'

export async function GET(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  const url = new URL(request.url); const from = url.searchParams.get('from') ?? ''; const to = url.searchParams.get('to') ?? ''
  const period = url.searchParams.get('period')
  if (period) {
    try { return Response.json({ success: true, data: await prepareReconciledVatDataset(user.id, period) }) }
    catch (error) { if (error instanceof VatValidationError) return Response.json({ success: false, issues: error.issues }, { status: 422 }); throw error }
  }
  if (!isRealDate(from) || !isRealDate(to) || from > to) return Response.json({ success: false, issues: ['A canonical VAT reconciliation date range is required.'] }, { status: 400 })
  try { return Response.json({ success: true, data: await reconcileTenantVat(user.id, from, to) }) }
  catch (error) { if (error instanceof VatValidationError) return Response.json({ success: false, issues: error.issues }, { status: 422 }); throw error }
}

function isRealDate(value: string) { if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const date = new Date(`${value}T00:00:00.000Z`); return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value }
