import 'server-only'
import { getCurrentUser } from '@/server/authentication'
import { forbiddenUnless } from '@/server/authorization'
import { confirmDocumentExtraction, DocumentExtractionError, extractDocumentInvoice, getDocumentExtraction } from '@/server/documentExtraction'

export const runtime = 'nodejs'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser(request.headers)
  if (!user) {
    return Response.json({ success: false }, { status: 401 })
  }
  const forbidden = forbiddenUnless(user, 'write'); if (forbidden) return forbidden
  const { id } = await params
  try { return Response.json({ success: true, data: await extractDocumentInvoice(user.id, id, user.actorId ?? user.id) }) }
  catch (error) { return extractionError(error) }
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  const extraction = await getDocumentExtraction(user.id, (await params).id)
  return extraction ? Response.json({ success: true, data: extraction }) : Response.json({ success: false }, { status: 404 })
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  const forbidden = forbiddenUnless(user, 'write'); if (forbidden) return forbidden
  try { return Response.json({ success: true, data: await confirmDocumentExtraction(user.id, (await params).id, user.actorId ?? user.id, await request.json()) }) }
  catch (error) { return extractionError(error) }
}

function extractionError(error: unknown) {
  if (error instanceof DocumentExtractionError) return Response.json({ success: false, error: error.message }, { status: error.status })
  if (error instanceof TypeError) return Response.json({ success: false, error: error.message }, { status: 400 })
  throw error
}
