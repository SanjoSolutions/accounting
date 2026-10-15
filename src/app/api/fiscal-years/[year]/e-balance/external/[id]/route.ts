import { getCurrentUser } from '@/server/authentication'
import { externalEBalance } from '@/server/externalEBalance/runtime'
import { externalDownload, externalError, externalYear, privateHeaders } from '@/server/externalEBalance/http'

export const runtime = 'nodejs'
export async function GET(request: Request, { params }: { params: Promise<{ year: string; id: string }> }) {
  const user = await getCurrentUser(request.headers); if (!user) return Response.json({ error: 'Anmeldung erforderlich.' }, { status: 401, headers: privateHeaders })
  try {
    const { year, id } = await params; const query = new URL(request.url).searchParams
    const preview = query.get('preview'); const file = preview ?? query.get('file') ?? undefined
    if (preview && !['manifest.json', 'susa.csv', 'myebilanz-salden.csv', 'myebilanz-mapping.ini.template', 'abstimmung.json', 'datengrundlage.json', 'e-bilanz.xbrl', 'ANLEITUNG.txt', 'SHA256SUMS.txt'].includes(preview)) return Response.json({ error: 'Vorschau nicht verfügbar.' }, { status: 400, headers: privateHeaders })
    const result = await externalEBalance.download(user.id, user.actorId, externalYear(year), id, file)
    return preview ? Response.json({ text: new TextDecoder().decode(result.content), contentHash: result.contentHash, packageHash: result.packageHash, sourceStatus: result.sourceStatus }, { headers: privateHeaders }) : externalDownload(result)
  } catch (error) { return externalError(error) }
}
