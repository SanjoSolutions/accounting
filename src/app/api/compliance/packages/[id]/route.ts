import 'server-only'

import { getCurrentUser } from '@/server/authentication'
import { authorizeComplianceTenant, complianceError } from '@/server/compliance/runtime'
import { downloadReportingPackage } from '@/server/compliance/reportingRepository'

export const runtime = 'nodejs'

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser(request.headers); if (!user) return Response.json({ success: false }, { status: 401 })
  try {
    const ownerId = await authorizeComplianceTenant(user.id, new URL(request.url).searchParams.get('tenantId'))
    const result = await downloadReportingPackage(ownerId, user.actorId, (await params).id)
    return new Response(new Uint8Array(result.content), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(result.content.byteLength), 'Content-Disposition': `attachment; filename="${result.fileName}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'X-Content-SHA256': result.contentHash } })
  } catch (error) { return complianceError(error) }
}
