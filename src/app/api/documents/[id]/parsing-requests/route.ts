import 'server-only'
import { requestDocumentParsing } from '@/server'

export const runtime = 'nodejs'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const invoice = await requestDocumentParsing(id)

  if (!invoice) {
    return Response.json({ success: false }, { status: 404 })
  }

  return Response.json({ success: true, data: invoice })
}
