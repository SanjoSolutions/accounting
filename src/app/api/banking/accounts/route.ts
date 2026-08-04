import 'server-only'
import { getCurrentUser } from '@/server/authentication'
import { bankingApiError } from '@/server/bankingApi'
import { createBankAccount, listBankAccounts } from '@/server/bankingRepository'
import { forbiddenUnless } from '@/server/authorization'

export async function GET(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  return Response.json({ success: true, data: await listBankAccounts(user.id) })
}

export async function POST(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  const forbidden = forbiddenUnless(user, 'write'); if (forbidden) return forbidden
  try { return Response.json({ success: true, data: await createBankAccount(user.id, user.actorId, await request.json()) }, { status: 201 }) }
  catch (error) { return bankingApiError(error) }
}
