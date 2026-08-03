import 'server-only'

import { getCurrentUser } from '@/server/authentication'
import { authorizeComplianceTenant, complianceError } from '@/server/compliance/runtime'
import { createHistoricalMappingsForFiscalYear } from '@/server/compliance/historicalMappings'

export async function POST(request: Request, { params }: { params: Promise<{ year: string }> }) {
  const user = await getCurrentUser(request.headers); if (!user) return Response.json({ success: false }, { status: 401 })
  try {
    const year = Number((await params).year); if (!Number.isSafeInteger(year)) throw new TypeError('Fiscal year must be an integer')
    const value: unknown = await request.json(); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Historical mapping request must be an object')
    const body = value as Record<string, unknown>; const ownerId = await authorizeComplianceTenant(user.id, body.tenantId)
    return Response.json({ success: true, data: await createHistoricalMappingsForFiscalYear(ownerId, user.id, year, body) }, { status: 201 })
  } catch (error) { return complianceError(error) }
}
