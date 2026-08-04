import 'server-only'
import { AccountingValidationError } from '@/core/doubleEntry'
import { getCurrentUser } from '@/server/authentication'
import { forbiddenUnless } from '@/server/authorization'
import { exportDatevBookingBatch } from '@/server/datevExport'

export const runtime = 'nodejs'

export async function POST(request: Request, { params }: { params: Promise<{ year: string }> }) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  const forbidden = forbiddenUnless(user, 'write'); if (forbidden) return forbidden
  try {
    const artifact = await exportDatevBookingBatch(user.id, user.actorId, Number((await params).year))
    return new Response(new Uint8Array(artifact.bytes), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${artifact.fileName}"`, 'x-content-sha256': artifact.contentHash, 'x-retained-artifact-id': artifact.retainedArtifactId } })
  } catch (error) {
    if (error instanceof AccountingValidationError) return Response.json({ success: false, issues: error.issues }, { status: 400 })
    throw error
  }
}
