import 'server-only'

import { getCurrentUser } from '@/server/authentication'
import { authorizeComplianceTenant, complianceError } from '@/server/compliance/runtime'
import { downloadEBalanceReport } from '@/server/compliance/eBilanzReportActions'

export const runtime = 'nodejs'

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  try {
    const ownerId = await authorizeComplianceTenant(user.id, new URL(request.url).searchParams.get('tenantId'))
    const result = await downloadEBalanceReport(ownerId, user.actorId, (await params).id)
    return new Response(new Uint8Array(result.content), { headers: {
      'content-type': result.contentType, 'content-disposition': `attachment; filename="${result.fileName}"`, 'cache-control': 'private, no-store',
    } })
  } catch (error) { return complianceError(error) }
}
