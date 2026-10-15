import { getCurrentUser } from '@/server/authentication'
import { forbiddenUnless, hasAccountingPermission } from '@/server/authorization'
import { externalEBalance } from '@/server/externalEBalance/runtime'
import { assertSameOrigin, externalError, externalYear, privateHeaders } from '@/server/externalEBalance/http'

export const runtime = 'nodejs'
type Context = { params: Promise<{ year: string }> }
export async function GET(request: Request, { params }: Context) {
  const user = await getCurrentUser(request.headers); if (!user) return Response.json({ error: 'Anmeldung erforderlich.' }, { status: 401, headers: privateHeaders })
  try { return Response.json({ ...await externalEBalance.overview(user.id, externalYear((await params).year)), canWrite: hasAccountingPermission(user, 'write') }, { headers: privateHeaders }) }
  catch (error) { return externalError(error) }
}
export async function POST(request: Request, { params }: Context) {
  const user = await getCurrentUser(request.headers); if (!user) return Response.json({ error: 'Anmeldung erforderlich.' }, { status: 401, headers: privateHeaders })
  const forbidden = forbiddenUnless(user, 'write'); if (forbidden) return forbidden
  try { assertSameOrigin(request); return Response.json(await externalEBalance.create(user.id, user.actorId, externalYear((await params).year)), { status: 201, headers: privateHeaders }) }
  catch (error) { return externalError(error) }
}
