import 'server-only'
import { getCurrentUser } from '@/server/authentication'
import { forbiddenUnless } from '@/server/authorization'
import { DocumentSearchError, indexDocumentSearch } from '@/server/documentSearch'

export const runtime = 'nodejs'
export const maxDuration = 90

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  const forbidden = forbiddenUnless(user, 'write'); if (forbidden) return forbidden
  try {
    return Response.json({ success: true, data: await indexDocumentSearch(user.id, (await context.params).id) })
  } catch (error) {
    if (error instanceof DocumentSearchError) return Response.json({ success: false, error: error.message }, { status: error.status })
    throw error
  }
}
