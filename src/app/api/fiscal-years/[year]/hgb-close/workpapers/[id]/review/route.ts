import 'server-only'
import { getCurrentUser } from '@/server/authentication'
import { authorizeComplianceTenant, complianceError } from '@/server/compliance/runtime'
import { reviewHgbWorkpaper } from '@/server/hgbWorkpaperRepository'

export async function POST(request: Request, { params }: { params: Promise<{ year: string; id: string }> }) {
  const user = await getCurrentUser(request.headers); if (!user) return Response.json({ success: false }, { status: 401 })
  try { const value: unknown = await request.json(); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Review request must be an object'); const body = value as Record<string, unknown>; const ownerId = await authorizeComplianceTenant(user.id, body.tenantId); if (body.decision !== 'APPROVE' && body.decision !== 'REJECT') throw new TypeError('Review decision must be APPROVE or REJECT'); return Response.json({ success: true, data: await reviewHgbWorkpaper(ownerId, user.id, (await params).id, body.decision, typeof body.reason === 'string' ? body.reason : undefined) }) } catch (error) { return complianceError(error) }
}
