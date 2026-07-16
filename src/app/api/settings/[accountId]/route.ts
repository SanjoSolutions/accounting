import 'server-only'
import { getSettings } from '@/server'

export const runtime = 'nodejs'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const { accountId } = await params
  const account = await getSettings(accountId)
  return Response.json({ success: true, data: account })
}
