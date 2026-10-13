import 'server-only'
import { getCurrentUser } from '@/server/authentication'
import { forbiddenUnless } from '@/server/authorization'
import { authorizeComplianceTenant, complianceError } from '@/server/compliance/runtime'
import { reviewHgbWorkpaper } from '@/server/hgbWorkpaperRepository'

export async function POST(request: Request, { params }: { params: Promise<{ year: string; id: string }> }) {
  const user = await getCurrentUser(request.headers); if (!user) return Response.json({ success: false }, { status: 401 })
  const forbidden = forbiddenUnless(user, 'write'); if (forbidden) return forbidden
  try { const value: unknown = await request.json(); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Review request must be an object'); const body = value as Record<string, unknown>; const ownerId = await authorizeComplianceTenant(user.id, body.tenantId); if (body.decision !== 'APPROVE' && body.decision !== 'REJECT') throw new TypeError('Review decision must be APPROVE or REJECT'); if (typeof body.reason !== 'string' || !body.reason.trim()) throw new TypeError('A review reason is required'); if (typeof body.expectedChecksum !== 'string' || body.expectedPolicyId !== null && typeof body.expectedPolicyId !== 'string') throw new TypeError('Current workpaper checksum and policy ID are required'); return Response.json({ success: true, data: await reviewHgbWorkpaper(ownerId, user.actorId, (await params).id, body.decision, body.reason, Number((await params).year), body.expectedChecksum, body.expectedPolicyId as string | null) }) } catch (error) { return complianceError(error) }
}
