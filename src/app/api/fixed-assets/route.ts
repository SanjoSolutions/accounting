import 'server-only'
import { getCurrentUser } from '@/server/authentication'
import { forbiddenUnless } from '@/server/authorization'
import { createFixedAsset, FixedAssetError, getFixedAssetWorkspace } from '@/server/fixedAssetsRepository'
import { ensureLedger } from '@/server/ledger'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const user = await getCurrentUser(request.headers); if (!user) return Response.json({ success: false }, { status: 401 })
  try {
    if (user.role !== 'READ_ONLY') await ensureLedger(user.id, new Date().getFullYear())
    return Response.json({ success: true, data: await getFixedAssetWorkspace(user.id) })
  } catch (error) { return assetError(error) }
}

export async function POST(request: Request) {
  const user = await getCurrentUser(request.headers); if (!user) return Response.json({ success: false }, { status: 401 })
  const forbidden = forbiddenUnless(user, 'write'); if (forbidden) return forbidden
  try { const input = await request.json(); await ensureLedger(user.id, Number(String(input.acquisitionDate).slice(0, 4))); return Response.json({ success: true, data: await createFixedAsset(user.id, user.actorId ?? user.id, input) }, { status: 201 }) } catch (error) { return assetError(error) }
}

function assetError(error: unknown) { if (error instanceof FixedAssetError || error instanceof TypeError) return Response.json({ success: false, error: error.message }, { status: error instanceof FixedAssetError ? error.status : 400 }); if (error instanceof SyntaxError) return Response.json({ success: false, error: error.message }, { status: 400 }); throw error }
