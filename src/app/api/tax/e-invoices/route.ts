import 'server-only'
import { EInvoiceValidationError } from '@/core/eInvoice'
import { getCurrentUser } from '@/server/authentication'
import { forbiddenUnless } from '@/server/authorization'
import { reconcilePendingOutgoingInvoiceAccounting, registerOutgoingStructuredInvoice } from '@/server/commercialAccountingRepository'
import { configureInvoiceNumberSequence, issueStructuredInvoice, listStructuredInvoices, reconcileInvoiceNumberSequence, requireInvoiceIssuanceBody, type StructuredInvoiceInput } from '@/server/tax/structuredInvoices'

export async function GET(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  if (user.role !== 'READ_ONLY') await reconcilePendingOutgoingInvoiceAccounting(user.id, user.actorId ?? user.id)
  return Response.json({ success: true, data: await listStructuredInvoices(user.id) })
}

export async function POST(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  const forbidden = forbiddenUnless(user, 'write'); if (forbidden) return forbidden
  try {
    const body = requireInvoiceIssuanceBody(await request.json()) as StructuredInvoiceInput & { action?: string; requestKey?: string; year?: number; firstUnusedNumber?: number; confirmedExistingSeries?: boolean; importedInvoiceNumbers?: string[] }
    if (body.action === 'configure-number-sequence') return Response.json({ success: true, data: await configureInvoiceNumberSequence(user.id, body.year!, body.firstUnusedNumber!, body.confirmedExistingSeries === true) }, { status: 201 })
    if (body.action === 'reconcile-number-sequence') return Response.json({ success: true, data: await reconcileInvoiceNumberSequence(user.id, user.actorId ?? user.id, body.year!, body.firstUnusedNumber!, body.importedInvoiceNumbers ?? [], body.confirmedExistingSeries === true) }, { status: 201 })
    const { requestKey = '', ...invoice } = body
    const issued = await issueStructuredInvoice(user.id, invoice as StructuredInvoiceInput, requestKey)
    await registerOutgoingStructuredInvoice(user.id, user.actorId ?? user.id, issued.id)
    return Response.json({ success: true, data: issued }, { status: 201 })
  } catch (error) {
    if (error instanceof EInvoiceValidationError || error instanceof SyntaxError) return Response.json({ success: false, issues: error instanceof EInvoiceValidationError ? error.issues : ['Invalid JSON body.'] }, { status: 400 })
    throw error
  }
}
