import 'server-only'
import { getCurrentUser } from '@/server/authentication'
import { forbiddenUnless } from '@/server/authorization'
import { commercialApiError, requireObject } from '@/server/commercialApi'
import { createCommercialDocumentDraft, finalizeCommercialDocument, type CommercialDraftInput } from '@/server/commercialAccountingRepository'

export async function POST(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  const forbidden = forbiddenUnless(user, 'write'); if (forbidden) return forbidden
  try {
    const body = requireObject(await request.json())
    if (body.action === 'finalize') return Response.json({ success: true, data: await finalizeCommercialDocument(user.id, user.actorId ?? user.id, body as unknown as Parameters<typeof finalizeCommercialDocument>[2]) })
    return Response.json({ success: true, data: await createCommercialDocumentDraft(user.id, user.actorId ?? user.id, body as unknown as CommercialDraftInput) }, { status: 201 })
  } catch (error) { return commercialApiError(error) }
}
