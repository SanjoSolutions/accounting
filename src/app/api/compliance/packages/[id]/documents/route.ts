import 'server-only'

import { getCurrentUser } from '@/server/authentication'
import { forbiddenUnless } from '@/server/authorization'
import { authorizeComplianceTenant, complianceError } from '@/server/compliance/runtime'
import { annualDocumentOptions, createAnnualDocumentBundle, downloadAnnualDocument } from '@/server/compliance/annualDocumentRepository'

export const runtime = 'nodejs'
type Context = { params: Promise<{ id: string }> }
const privateResponse = (response: Response) => { response.headers.set('Cache-Control', 'private, no-store'); return response }

export async function GET(request: Request, context: Context) {
  const user = await getCurrentUser(request.headers)
  if (!user) return privateResponse(Response.json({ success: false }, { status: 401 }))
  try {
    const url = new URL(request.url)
    const ownerId = await authorizeComplianceTenant(user.id, url.searchParams.get('tenantId'))
    const { id } = await context.params
    const artifactId = url.searchParams.get('artifactId')
    if (!artifactId) return privateResponse(Response.json({ success: true, data: await annualDocumentOptions(ownerId, id) }))
    const result = await downloadAnnualDocument(ownerId, user.actorId, id, artifactId, url.searchParams.get('file') ?? 'bundle')
    return privateResponse(new Response(new Uint8Array(result.content), { headers: { 'Content-Type': result.contentType, 'Content-Length': String(result.content.byteLength), 'Content-Disposition': `${result.contentType.startsWith('text/html') ? 'inline' : 'attachment'}; filename="${result.fileName}"`, 'X-Content-Type-Options': 'nosniff', 'X-Content-SHA256': result.contentHash, 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'Referrer-Policy': 'no-referrer' } }))
  } catch (error) { return privateResponse(complianceError(error)) }
}

export async function POST(request: Request, context: Context) {
  const user = await getCurrentUser(request.headers)
  if (!user) return privateResponse(Response.json({ success: false }, { status: 401 }))
  const forbidden = forbiddenUnless(user, 'write'); if (forbidden) return privateResponse(forbidden)
  try {
    const body = await request.json()
    if (!body || typeof body !== 'object' || Array.isArray(body)) return privateResponse(Response.json({ success: false, error: 'Document request must be an object' }, { status: 400 }))
    const ownerId = await authorizeComplianceTenant(user.id, body.tenantId)
    const data = await createAnnualDocumentBundle(ownerId, user.actorId, (await context.params).id, body)
    return privateResponse(Response.json({ success: true, data }, { status: 201 }))
  } catch (error) { return privateResponse(complianceError(error)) }
}
