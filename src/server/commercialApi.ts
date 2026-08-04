import { Prisma } from '@/generated/prisma/client'
import { CommercialAccountingError } from '@/server/commercialAccountingRepository'
import { ReceivablesReminderError } from '@/core/receivablesReminder'

export function commercialApiError(error: unknown) {
  if (error instanceof CommercialAccountingError || error instanceof ReceivablesReminderError || error instanceof SyntaxError || error instanceof TypeError) return Response.json({ success: false, error: error.message }, { status: 400 })
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return Response.json({ success: false, error: 'A commercial record with this tenant identity already exists.' }, { status: 409 })
  if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2003', 'P2004'].includes(error.code)) return Response.json({ success: false, error: 'The commercial record violates a tenant relation or accounting constraint.' }, { status: 400 })
  throw error
}

export function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CommercialAccountingError('A JSON object is required.')
  return value as Record<string, unknown>
}
