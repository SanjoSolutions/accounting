import 'server-only'
import { EInvoiceValidationError, type InvoiceDocumentKind } from '@/core/eInvoice'
import { getCurrentUser } from '@/server/authentication'
import { correctStructuredInvoice, requireInvoiceIssuanceBody, type StructuredInvoiceInput } from '@/server/tax/structuredInvoices'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  try {
    const body = requireInvoiceIssuanceBody(await request.json()) as Omit<StructuredInvoiceInput, 'kind' | 'correctedInvoiceNumber'> & { kind: Exclude<InvoiceDocumentKind, 'invoice'>; requestKey?: string }
    const { requestKey = '', ...correction } = body
    return Response.json({ success: true, data: await correctStructuredInvoice(user.id, (await params).id, correction, requestKey) }, { status: 201 })
  } catch (error) {
    if (error instanceof EInvoiceValidationError || error instanceof SyntaxError) return Response.json({ success: false, issues: error instanceof EInvoiceValidationError ? error.issues : ['Invalid JSON body.'] }, { status: 400 })
    throw error
  }
}
