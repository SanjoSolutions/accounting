import 'server-only'
import { getCurrentUser } from '@/server/authentication'
import { bankingApiError } from '@/server/bankingApi'
import { importCamtStatement } from '@/server/bankingRepository'
import { forbiddenUnless } from '@/server/authorization'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  const forbidden = forbiddenUnless(user, 'write'); if (forbidden) return forbidden
  try {
    const bankAccountId = request.headers.get('x-bank-account-id')?.trim()
    if (!bankAccountId) return Response.json({ success: false, error: 'Select a bank account.' }, { status: 400 })
    const content = new Uint8Array(await request.arrayBuffer())
    return Response.json({ success: true, data: await importCamtStatement(user.id, user.actorId, bankAccountId, content) }, { status: 201 })
  } catch (error) { return bankingApiError(error) }
}
