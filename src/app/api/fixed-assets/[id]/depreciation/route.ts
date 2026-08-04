import 'server-only'
import { getCurrentUser } from '@/server/authentication'
import { forbiddenUnless } from '@/server/authorization'
import { FixedAssetError, postFixedAssetDepreciation } from '@/server/fixedAssetsRepository'
import { ensureLedger } from '@/server/ledger'

export const runtime = 'nodejs'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser(request.headers); if (!user) return Response.json({ success: false }, { status: 401 })
  const forbidden = forbiddenUnless(user, 'write'); if (forbidden) return forbidden
  try { const input = await request.json(); await ensureLedger(user.id, Number(String(input.period).slice(0, 4))); return Response.json({ success: true, data: await postFixedAssetDepreciation(user.id, user.actorId ?? user.id, (await params).id, input.period, input.reason) }) } catch (error) { return assetError(error) }
}

function assetError(error: unknown) { if (error instanceof FixedAssetError || error instanceof TypeError) return Response.json({ success: false, error: error.message }, { status: error instanceof FixedAssetError ? error.status : 400 }); if (error instanceof SyntaxError) return Response.json({ success: false, error: error.message }, { status: 400 }); throw error }
