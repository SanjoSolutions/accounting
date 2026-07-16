import 'server-only'
import { requestDocumentParsing } from '@/server'
import { getCurrentUser } from '@/server/authentication'

export const runtime = 'nodejs'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser(request.headers)
  if (!user) {
    return Response.json({ success: false }, { status: 401 })
  }
  const { id } = await params
  const invoice = await requestDocumentParsing(id, user.id)

  if (!invoice) {
    return Response.json({ success: false }, { status: 404 })
  }

  return Response.json({ success: true, data: invoice })
}
