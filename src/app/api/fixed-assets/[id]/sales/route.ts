import 'server-only'
import { getCurrentUser } from '@/server/authentication'
import { forbiddenUnless } from '@/server/authorization'
import { FixedAssetError, sellFixedAsset } from '@/server/fixedAssetsRepository'
import { ensureLedger } from '@/server/ledger'

export const runtime = 'nodejs'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser(request.headers); if (!user) return Response.json({ success: false }, { status: 401 })
  const forbidden = forbiddenUnless(user, 'write'); if (forbidden) return forbidden
  try {
    const input = await request.json()
    await ensureLedger(user.id, Number(String(input.effectiveDate).slice(0, 4)))
    return Response.json({ success: true, data: await sellFixedAsset(user.id, user.actorId ?? user.id, (await params).id, input) })
  } catch (error) {
    if (error instanceof FixedAssetError || error instanceof TypeError) return Response.json({ success: false, error: error.message }, { status: error instanceof FixedAssetError ? error.status : 400 })
    if (error instanceof SyntaxError) return Response.json({ success: false, error: error.message }, { status: 400 })
    throw error
  }
}
