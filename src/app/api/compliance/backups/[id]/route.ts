import 'server-only'
import { getCurrentUser } from '@/server/authentication'
import { forbiddenUnless } from '@/server/authorization'
import { authorizeComplianceTenant, complianceError, downloadTenantBackupPayload, verifyTenantBackupPayload } from '@/server/compliance/runtime'

export const runtime = 'nodejs'
const MAX_BACKUP_BYTES = 100 * 1024 * 1024

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser(request.headers); if (!user) return Response.json({ success: false }, { status: 401 })
  try {
    const ownerId = await authorizeComplianceTenant(user.id, new URL(request.url).searchParams.get('tenantId'))
    const backup = await downloadTenantBackupPayload(ownerId, user.actorId, (await params).id)
    return new Response(new Uint8Array(backup.content), { headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename="${backup.fileName}"`, 'cache-control': 'no-store' } })
  } catch (error) { return complianceError(error) }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser(request.headers); if (!user) return Response.json({ success: false }, { status: 401 })
  const forbidden = forbiddenUnless(user, 'write'); if (forbidden) return forbidden
  try {
    const declared = Number(request.headers.get('content-length')); if (Number.isFinite(declared) && declared > MAX_BACKUP_BYTES) return Response.json({ success: false, error: 'Backup payload exceeds 100 MiB' }, { status: 413 })
    const content = new Uint8Array(await request.arrayBuffer()); if (!content.length || content.length > MAX_BACKUP_BYTES) return Response.json({ success: false, error: 'Backup payload is empty or exceeds 100 MiB' }, { status: content.length ? 413 : 400 })
    const ownerId = await authorizeComplianceTenant(user.id, new URL(request.url).searchParams.get('tenantId'))
    return Response.json({ success: true, data: await verifyTenantBackupPayload(ownerId, user.actorId, (await params).id, content) })
  } catch (error) { return complianceError(error) }
}
