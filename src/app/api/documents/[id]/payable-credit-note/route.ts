import 'server-only'
import { getCurrentUser } from '@/server/authentication'
import { forbiddenUnless } from '@/server/authorization'
import { getIncomingSupplierCreditContext, IncomingSupplierCreditNoteError, postIncomingSupplierCredit } from '@/server/incomingSupplierCreditNote'

export const runtime = 'nodejs'

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  try { return Response.json({ success: true, data: await getIncomingSupplierCreditContext(user.id, (await params).id) }) }
  catch (error) { return supplierCreditError(error) }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  const forbidden = forbiddenUnless(user, 'write'); if (forbidden) return forbidden
  try { return Response.json({ success: true, data: await postIncomingSupplierCredit(user.id, user.actorId ?? user.id, (await params).id, await request.json()) }) }
  catch (error) { return supplierCreditError(error) }
}

function supplierCreditError(error: unknown) {
  if (error instanceof IncomingSupplierCreditNoteError) return Response.json({ success: false, error: error.message }, { status: error.status })
  if (error instanceof TypeError || error instanceof SyntaxError) return Response.json({ success: false, error: error.message }, { status: 400 })
  throw error
}
