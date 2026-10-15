import { getCurrentUser } from '@/server/authentication'
import { forbiddenUnless } from '@/server/authorization'
import { externalEBalance } from '@/server/externalEBalance/runtime'
import { assertSameOrigin, externalDownload, externalError, externalEvidenceForm, externalYear, privateHeaders } from '@/server/externalEBalance/http'

export const runtime = 'nodejs'
type Context = { params: Promise<{ year: string; id: string }> }
export async function POST(request: Request, { params }: Context) {
  const user = await getCurrentUser(request.headers); if (!user) return Response.json({ error: 'Anmeldung erforderlich.' }, { status: 401, headers: privateHeaders })
  const forbidden = forbiddenUnless(user, 'write'); if (forbidden) return forbidden
  try {
    assertSameOrigin(request); const { year, id } = await params
    return Response.json(await externalEBalance.attachEvidence(user.id, user.actorId, externalYear(year), id, await externalEvidenceForm(request)), { status: 201, headers: privateHeaders })
  } catch (error) { return externalError(error) }
}
export async function GET(request: Request, { params }: Context) {
  const user = await getCurrentUser(request.headers); if (!user) return Response.json({ error: 'Anmeldung erforderlich.' }, { status: 401, headers: privateHeaders })
  try {
    const { year, id } = await params
    const result = await externalEBalance.downloadEvidence(user.id, user.actorId, externalYear(year), id, new URL(request.url).searchParams.get('evidenceId') ?? '')
    return externalDownload(result)
  } catch (error) { return externalError(error) }
}
