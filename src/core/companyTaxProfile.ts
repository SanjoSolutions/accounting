/** Income-tax accounting is independent of the company's VAT regime. */
export interface SoleTraderTaxProfile {
  profitDetermination: 'BALANCE_SHEET' | 'EUER'
  incomeType: 'TRADE' | 'SELF_EMPLOYED'
  euerEligibilityConfirmed: boolean
}

export interface CompanyIncomeTaxFacts {
  legalForm: string
  soleTraderTaxProfile?: SoleTraderTaxProfile
}

export function validateSoleTraderTaxProfile(legalForm: unknown, value: unknown): string[] {
  if (value === undefined) return []
  if (legalForm !== 'SOLE_TRADER') return ['soleTraderTaxProfile requires a sole trader']
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['soleTraderTaxProfile is invalid']
  const facts = value as Partial<SoleTraderTaxProfile>
  if (!['BALANCE_SHEET', 'EUER'].includes(facts.profitDetermination ?? '')
    || !['TRADE', 'SELF_EMPLOYED'].includes(facts.incomeType ?? '')
    || typeof facts.euerEligibilityConfirmed !== 'boolean') return ['soleTraderTaxProfile requires accounting method, income type and eligibility facts']
  if (facts.profitDetermination === 'EUER' && !facts.euerEligibilityConfirmed) return ['EÜR requires confirmation that no statutory or voluntary balance-sheet accounting applies']
  return []
}

export function usesEuer(profile: CompanyIncomeTaxFacts): boolean {
  return profile.legalForm === 'SOLE_TRADER'
    && profile.soleTraderTaxProfile?.profitDetermination === 'EUER'
    && profile.soleTraderTaxProfile.euerEligibilityConfirmed === true
}
