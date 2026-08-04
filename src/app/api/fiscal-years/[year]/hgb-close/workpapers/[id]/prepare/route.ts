import 'server-only'
import { getCurrentUser } from '@/server/authentication'
import { forbiddenUnless } from '@/server/authorization'
import { authorizeComplianceTenant, complianceError } from '@/server/compliance/runtime'
import { prepareHgbWorkpaper } from '@/server/hgbWorkpaperRepository'

export async function POST(request: Request, { params }: { params: Promise<{ year: string; id: string }> }) {
  const user = await getCurrentUser(request.headers); if (!user) return Response.json({ success: false }, { status: 401 })
  const forbidden = forbiddenUnless(user, 'write'); if (forbidden) return forbidden
  try { const value: unknown = await request.json(); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Prepare request must be an object'); const body = value as Record<string, unknown>; const ownerId = await authorizeComplianceTenant(user.id, body.tenantId); const id = (await params).id; if (typeof body.expectedChecksum !== 'string') throw new TypeError('expectedChecksum is required'); return Response.json({ success: true, data: await prepareHgbWorkpaper(ownerId, user.actorId, id, body.expectedChecksum) }) } catch (error) { return complianceError(error) }
}
