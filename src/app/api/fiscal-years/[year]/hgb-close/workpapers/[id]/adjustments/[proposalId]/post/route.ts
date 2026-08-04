import 'server-only'
import { getCurrentUser } from '@/server/authentication'
import { forbiddenUnless } from '@/server/authorization'
import { authorizeComplianceTenant, complianceError } from '@/server/compliance/runtime'
import { postHgbAdjustment } from '@/server/hgbWorkpaperRepository'

export async function POST(request: Request, { params }: { params: Promise<{ year: string; id: string; proposalId: string }> }) {
  const user = await getCurrentUser(request.headers); if (!user) return Response.json({ success: false }, { status: 401 })
  const forbidden = forbiddenUnless(user, 'write'); if (forbidden) return forbidden
  try { const value: unknown = await request.json(); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Adjustment post request must be an object'); const body = value as Record<string, unknown>; const ownerId = await authorizeComplianceTenant(user.id, body.tenantId); if (typeof body.idempotencyKey !== 'string') throw new TypeError('idempotencyKey is required'); const route = await params; const year = Number(route.year); if (!Number.isSafeInteger(year)) throw new TypeError('Fiscal year must be an integer'); return Response.json({ success: true, data: await postHgbAdjustment(ownerId, user.actorId, year, route.id, route.proposalId, body.idempotencyKey) }) } catch (error) { return complianceError(error) }
}
