import 'server-only'
import { getCurrentUser } from '@/server/authentication'
import { listOpenItems } from '@/server/commercialAccountingRepository'

export async function GET(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  return Response.json({ success: true, data: await listOpenItems(user.id) })
}
