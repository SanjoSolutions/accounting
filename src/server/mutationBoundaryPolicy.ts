import type { AccountingPermission } from './authorization'

export type MutationBoundaryPolicy = AccountingPermission | 'public_auth' | 'tenant_selection' | 'session_preference' | 'conditional_maintenance' | 'audited_read'

/**
 * Complete, reviewable classification of every non-GET application boundary.
 * `mutationBoundaryPolicy.spec.ts` compares this registry with the filesystem,
 * so adding a route or server action without an explicit policy fails CI.
 */
export const apiMutationBoundaryPolicy = {
  '/api/access/active-tenant#POST': 'tenant_selection',
  '/api/access#POST': 'manage_access',
  '/api/accounting-import#POST': 'write',
  '/api/auth/[...all]#POST': 'public_auth',
  '/api/banking/accounts#POST': 'write',
  '/api/banking/matches/[id]/reversals#POST': 'write',
  '/api/banking/statements#POST': 'write',
  '/api/banking/transactions/[id]/matches#POST': 'write',
  '/api/booking-records#POST': 'write',
  '/api/commercial/documents#POST': 'write',
  '/api/commercial/open-items/[id]/allocations#POST': 'write',
  '/api/commercial/partners#POST': 'write',
  '/api/commercial/payments#POST': 'write',
  '/api/commercial/reminders/[id]/cancellations#POST': 'write',
  '/api/commercial/reminders/[id]/deliveries#POST': 'write',
  '/api/commercial/reminders#POST': 'write',
  '/api/compliance/backups/[id]#POST': 'write',
  '/api/compliance/e-bilanz#POST': 'write',
  '/api/compliance#POST': 'write',
  '/api/datev-export/[year]#POST': 'write',
  '/api/datev-import#POST': 'write',
  '/api/documents/[id]/parsing-requests#PATCH': 'write',
  '/api/documents/[id]/parsing-requests#POST': 'write',
  '/api/documents/[id]/payable-posting#POST': 'write',
  '/api/documents#POST': 'write',
  '/api/fiscal-years/[year]/close#POST': 'write',
  '/api/fiscal-years/[year]/e-balance/submit#POST': 'write',
  '/api/fiscal-years/[year]/e-balance/validate#POST': 'write',
  '/api/fiscal-years/[year]/e-balance#POST': 'write',
  '/api/fiscal-years/[year]/hgb-close/mappings#POST': 'write',
  '/api/fiscal-years/[year]/hgb-close/profile#POST': 'write',
  '/api/fiscal-years/[year]/hgb-close/workpapers/[id]/adjustments/[proposalId]/post#POST': 'write',
  '/api/fiscal-years/[year]/hgb-close/workpapers/[id]/prepare#POST': 'write',
  '/api/fiscal-years/[year]/hgb-close/workpapers/[id]/review#POST': 'write',
  '/api/fiscal-years/[year]/hgb-close/workpapers#PUT': 'write',
  '/api/fiscal-years/[year]/hgb-close#POST': 'write',
  '/api/fixed-assets/[id]/depreciation/[eventId]/reversal#POST': 'write',
  '/api/fixed-assets/[id]/depreciation#POST': 'write',
  '/api/fixed-assets/[id]/disposals#POST': 'write',
  '/api/fixed-assets/[id]/sales#POST': 'write',
  '/api/fixed-assets#POST': 'write',
  '/api/settings#PUT': 'write',
  '/api/tax/annual/adjustments#POST': 'write',
  '/api/tax/annual/narrow#POST': 'write',
  '/api/tax/annual#POST': 'write',
  '/api/tax/assessments#POST': 'write',
  '/api/tax/e-invoices/[id]/corrections#POST': 'write',
  '/api/tax/e-invoices#POST': 'write',
  '/api/tax/vat-postings#POST': 'write',
  '/api/tax/workflows/[id]#POST': 'write',
  '/api/tax/workflows#POST': 'write',
} as const satisfies Record<string, MutationBoundaryPolicy>

export const serverActionBoundaryPolicy = {
  'src/i18n/actions.ts#setLocale': 'session_preference',
} as const satisfies Record<string, MutationBoundaryPolicy>

export const sideEffectingReadBoundaryPolicy = {
  '/api/compliance/backups/[id]#GET': 'audited_read',
  '/api/fiscal-years/[year]/e-balance/eric-status#GET': 'conditional_maintenance',
  '/api/fixed-assets#GET': 'conditional_maintenance',
  '/api/tax/e-invoices#GET': 'conditional_maintenance',
} as const satisfies Record<string, MutationBoundaryPolicy>
