import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
import { exactNarrowCapitalCompanyFacts, exactNarrowUg2025Facts } from './narrowUgAnnualRepository'

const supportedProfile = {
  legalForm: 'UG',
  annualTaxProfile: {
    tradeBusiness: true,
    establishments: 1,
    municipalityCode: '11000000',
    tradeTaxMultiplierBasisPoints: 41_000,
    foreignIncome: false,
    groupOrConsolidation: false,
    lossCarry: false,
    specialRegime: false,
    withholdingOrCredits: false,
    payroll: false,
  },
}

describe('narrow UG annual tax applicability', () => {
  it.each([['UG', 2025], ['UG', 2026], ['GMBH', 2025], ['GMBH', 2026]] as const)('Given a supported %s profile, when the %i annual scope is derived, then exact capital-company facts are returned', (legalForm, year) => {
    expect(exactNarrowCapitalCompanyFacts({ ...supportedProfile, legalForm } as Parameters<typeof exactNarrowCapitalCompanyFacts>[0], year)).toMatchObject({ legalForm, year, establishments: 1 })
  })
  it('Given more than one trade-tax establishment, when GewSt preparation is scoped, then it fails closed instead of calculating an unsupported declaration', () => {
    expect(() => exactNarrowUg2025Facts({
      ...supportedProfile,
      annualTaxProfile: { ...supportedProfile.annualTaxProfile, establishments: 2 },
    } as Parameters<typeof exactNarrowUg2025Facts>[0])).toThrow(/one .*trade-tax establishment/)
  })
  it('Given a short fiscal scope or unsupported assessment year, when facts are derived, then it fails closed', () => {
    expect(() => exactNarrowCapitalCompanyFacts(supportedProfile as Parameters<typeof exactNarrowCapitalCompanyFacts>[0], 2027)).toThrow(/2025\/2026/)
  })
  it('keeps the original 2025 UG entry point fail-closed for GmbH callers', () => {
    expect(() => exactNarrowUg2025Facts({ ...supportedProfile, legalForm: 'GMBH' } as Parameters<typeof exactNarrowUg2025Facts>[0])).toThrow(/requires legal form UG/)
  })
})
