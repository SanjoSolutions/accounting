import 'server-only'

import { getCurrentUser } from '@/server/authentication'
import { forbiddenUnless } from '@/server/authorization'
import { authorizeComplianceTenant, complianceError } from '@/server/compliance/runtime'
import { createHistoricalProfileForFiscalYear } from '@/server/compliance/historicalProfile'

export async function POST(request: Request, { params }: { params: Promise<{ year: string }> }) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  const forbidden = forbiddenUnless(user, 'write'); if (forbidden) return forbidden
  try {
    const year = Number((await params).year)
    if (!Number.isSafeInteger(year)) return Response.json({ success: false, error: 'Fiscal year must be an integer' }, { status: 400 })
    const body: unknown = await request.json()
    if (!body || typeof body !== 'object' || Array.isArray(body)) return Response.json({ success: false, error: 'Historical profile request body must be an object' }, { status: 400 })
    const ownerId = await authorizeComplianceTenant(user.id, (body as Record<string, unknown>).tenantId)
    return Response.json({ success: true, data: await createHistoricalProfileForFiscalYear(ownerId, user.actorId, year, body as Record<string, unknown>) }, { status: 201 })
  } catch (error) { return complianceError(error) }
}
