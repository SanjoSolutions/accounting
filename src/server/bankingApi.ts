import { BankStatementValidationError, BankingError } from './bankingRepository'

export function bankingApiError(error: unknown) {
  if (error instanceof BankStatementValidationError || error instanceof BankingError) return Response.json({ success: false, error: error.message }, { status: 400 })
  if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') return Response.json({ success: false, error: 'This tenant bank identity already exists.' }, { status: 409 })
  return Response.json({ success: false, error: 'The banking request could not be processed.' }, { status: 500 })
}
