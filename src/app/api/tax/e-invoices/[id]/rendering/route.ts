import 'server-only'
import { getCurrentUser } from '@/server/authentication'
import { getStructuredInvoiceRendering } from '@/server/tax/structuredInvoices'

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  const record = await getStructuredInvoiceRendering(user.id, (await params).id)
  return record ? new Response(record.renderedHtml, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'none'; img-src 'none'; frame-ancestors 'none'; sandbox" } }) : Response.json({ success: false }, { status: 404 })
}
