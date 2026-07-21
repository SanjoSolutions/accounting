import 'server-only'
import { EInvoiceValidationError } from '@/core/eInvoice'
import { getCurrentUser } from '@/server/authentication'
import { configureInvoiceNumberSequence, issueStructuredInvoice, listStructuredInvoices, reconcileInvoiceNumberSequence, requireInvoiceIssuanceBody, type StructuredInvoiceInput } from '@/server/tax/structuredInvoices'

export async function GET(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  return Response.json({ success: true, data: await listStructuredInvoices(user.id) })
}

export async function POST(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  try {
    const body = requireInvoiceIssuanceBody(await request.json()) as StructuredInvoiceInput & { action?: string; requestKey?: string; year?: number; firstUnusedNumber?: number; confirmedExistingSeries?: boolean; importedInvoiceNumbers?: string[] }
    if (body.action === 'configure-number-sequence') return Response.json({ success: true, data: await configureInvoiceNumberSequence(user.id, body.year!, body.firstUnusedNumber!, body.confirmedExistingSeries === true) }, { status: 201 })
    if (body.action === 'reconcile-number-sequence') return Response.json({ success: true, data: await reconcileInvoiceNumberSequence(user.id, user.id, body.year!, body.firstUnusedNumber!, body.importedInvoiceNumbers ?? [], body.confirmedExistingSeries === true) }, { status: 201 })
    const { requestKey = '', ...invoice } = body
    return Response.json({ success: true, data: await issueStructuredInvoice(user.id, invoice as StructuredInvoiceInput, requestKey) }, { status: 201 })
  } catch (error) {
    if (error instanceof EInvoiceValidationError || error instanceof SyntaxError) return Response.json({ success: false, issues: error instanceof EInvoiceValidationError ? error.issues : ['Invalid JSON body.'] }, { status: 400 })
    throw error
  }
}
