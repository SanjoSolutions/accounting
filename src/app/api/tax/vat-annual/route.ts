import 'server-only'

import { VatValidationError } from '@/core/vatEngine'
import { getCurrentUser } from '@/server/authentication'
import { prepareReconciledAnnualVatDataset } from '@/server/tax/vatRepository'

export async function GET(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  const rawYear = new URL(request.url).searchParams.get('year')
  const year = rawYear && /^\d{4}$/.test(rawYear) ? Number(rawYear) : Number.NaN
  try { return Response.json({ success: true, data: await prepareReconciledAnnualVatDataset(user.id, year) }) }
  catch (error) {
    if (error instanceof VatValidationError) return Response.json({ success: false, issues: error.issues }, { status: 422 })
    throw error
  }
}
