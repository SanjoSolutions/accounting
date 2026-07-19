import 'server-only'
import { TaxDeclarationError } from '@/core/taxDeclarations'
import { TaxGatewayConfigurationError } from './workflows'

export function taxError(error: unknown) {
  if (error instanceof TaxGatewayConfigurationError) return Response.json({ success: false, issues: [error.message] }, { status: 503 })
  if (error instanceof TaxDeclarationError || error instanceof SyntaxError) return Response.json({ success: false, issues: error instanceof TaxDeclarationError ? error.issues : ['Invalid JSON body.'] }, { status: 400 })
  throw error
}

export function requireTaxJsonObject(value: unknown, label = 'Tax request'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TaxDeclarationError([`${label} must be a JSON object.`])
  return value as Record<string, unknown>
}
