import 'server-only'
import { EInvoiceValidationError, type InvoiceDocumentKind } from '@/core/eInvoice'
import { getCurrentUser } from '@/server/authentication'
import { forbiddenUnless } from '@/server/authorization'
import { correctStructuredInvoice, getOutgoingStructuredCorrectionTemplate, requireInvoiceIssuanceBody, type StructuredInvoiceInput } from '@/server/tax/structuredInvoices'

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser(request.headers); if (!user) return Response.json({ success: false }, { status: 401 })
  try { return Response.json({ success: true, data: await getOutgoingStructuredCorrectionTemplate(user.id, (await params).id) }) } catch (error) { if (error instanceof EInvoiceValidationError) return Response.json({ success: false, issues: error.issues }, { status: 400 }); throw error }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  const forbidden = forbiddenUnless(user, 'write'); if (forbidden) return forbidden
  try {
    const body = requireInvoiceIssuanceBody(await request.json()) as Omit<StructuredInvoiceInput, 'kind' | 'correctedInvoiceNumber'> & { kind: Exclude<InvoiceDocumentKind, 'invoice'>; requestKey?: string }
    const { requestKey = '', ...correction } = body
    return Response.json({ success: true, data: await correctStructuredInvoice(user.id, (await params).id, correction, requestKey) }, { status: 201 })
  } catch (error) {
    if (error instanceof EInvoiceValidationError || error instanceof SyntaxError) return Response.json({ success: false, issues: error instanceof EInvoiceValidationError ? error.issues : ['Invalid JSON body.'] }, { status: 400 })
    throw error
  }
}
