import 'server-only'

import { getCurrentUser } from '@/server/authentication'
import { authorizeComplianceTenant, complianceError } from '@/server/compliance/runtime'
import { getEBalanceLifecycleOverview, prepareEBalanceLifecycleReport, recordEBalanceReconciliation, registerEBalanceTaxonomy } from '@/server/compliance/eBilanzRepository'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const user = await getCurrentUser(request.headers); if (!user) return Response.json({ success: false }, { status: 401 })
  try { const url = new URL(request.url); const ownerId = await authorizeComplianceTenant(user.id, url.searchParams.get('tenantId')); return Response.json({ success: true, data: await getEBalanceLifecycleOverview(ownerId, url.searchParams.get('fiscalYearId') ?? undefined) }) } catch (error) { return complianceError(error) }
}

export async function POST(request: Request) {
  const user = await getCurrentUser(request.headers); if (!user) return Response.json({ success: false }, { status: 401 })
  try {
    const value: unknown = await request.json(); if (!value || typeof value !== 'object' || Array.isArray(value)) return Response.json({ success: false, error: 'E-Bilanz lifecycle request must be an object' }, { status: 400 })
    const body = value as Record<string, unknown>; const ownerId = await authorizeComplianceTenant(user.id, body.tenantId); let data: unknown
    switch (body.action) {
      case 'taxonomy.register': data = await registerEBalanceTaxonomy(user.id, body); break
      case 'reconciliation.record': data = await recordEBalanceReconciliation(ownerId, user.id, body); break
      case 'report.prepare': data = await prepareEBalanceLifecycleReport(ownerId, user.id, body); break
      default: return Response.json({ success: false, error: 'Unsupported E-Bilanz lifecycle action' }, { status: 400 })
    }
    return Response.json({ success: true, data }, { status: 201 })
  } catch (error) { return complianceError(error) }
}
