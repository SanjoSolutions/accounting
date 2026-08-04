import 'server-only'
import { getCurrentUser } from '@/server/authentication'
import { forbiddenUnless } from '@/server/authorization'
import { FixedAssetError, reverseFixedAssetDepreciation } from '@/server/fixedAssetsRepository'
import { ensureLedger } from '@/server/ledger'

export const runtime = 'nodejs'

export async function POST(request: Request, { params }: { params: Promise<{ id: string; eventId: string }> }) {
  const user = await getCurrentUser(request.headers); if (!user) return Response.json({ success: false }, { status: 401 })
  const forbidden = forbiddenUnless(user, 'write'); if (forbidden) return forbidden
  try { const input = await request.json(); await ensureLedger(user.id, Number(String(input.effectiveDate).slice(0, 4))); const { id, eventId } = await params; return Response.json({ success: true, data: await reverseFixedAssetDepreciation(user.id, user.actorId ?? user.id, id, eventId, input.effectiveDate, input.reason) }) } catch (error) { return assetError(error) }
}

function assetError(error: unknown) { if (error instanceof FixedAssetError || error instanceof TypeError) return Response.json({ success: false, error: error.message }, { status: error instanceof FixedAssetError ? error.status : 400 }); if (error instanceof SyntaxError) return Response.json({ success: false, error: error.message }, { status: 400 }); throw error }
