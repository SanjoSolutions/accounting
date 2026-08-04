import 'server-only'
import { getCurrentUser } from '@/server/authentication'
import { bankingApiError } from '@/server/bankingApi'
import { confirmBankTransactionMatch } from '@/server/bankingRepository'
import { forbiddenUnless } from '@/server/authorization'

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  const forbidden = forbiddenUnless(user, 'write'); if (forbidden) return forbidden
  try {
    const key = request.headers.get('idempotency-key') ?? ''; const { id } = await context.params
    return Response.json({ success: true, data: await confirmBankTransactionMatch(user.id, user.actorId, id, key, await request.json()) }, { status: 201 })
  } catch (error) { return bankingApiError(error) }
}
