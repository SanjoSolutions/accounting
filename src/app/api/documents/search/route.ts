import 'server-only'
import { getCurrentUser } from '@/server/authentication'
import { searchDocuments } from '@/server/documentSearch'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  const params = new URL(request.url).searchParams
  const scope = params.get('scope') ?? 'available'
  if (scope !== 'available' && scope !== 'all') return Response.json({ success: false, error: 'Invalid document scope.' }, { status: 400 })
  try {
    const data = await searchDocuments(user.id, params.get('q') ?? '', Number(params.get('offset') ?? 0), scope)
    return Response.json({ success: true, data }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    if (error instanceof RangeError) return Response.json({ success: false, error: error.message }, { status: 400 })
    throw error
  }
}
