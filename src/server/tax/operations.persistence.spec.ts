import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fiscalYear: vi.fn(), mappings: vi.fn(), drafts: vi.fn(), eBilanz: vi.fn(), sequence: vi.fn(), onboarding: vi.fn(), profile: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/persistence/client', () => ({ prisma: {
  fiscalYear: { findFirst: mocks.fiscalYear }, accountMappingVersion: { findMany: mocks.mappings }, journalEntry: { count: mocks.drafts },
  eBalanceSubmission: { findFirst: mocks.eBilanz }, invoiceNumberSequence: { findUnique: mocks.sequence }, invoiceNumberSequenceOnboarding: { findUnique: mocks.onboarding },
} }))
vi.mock('./profileRepository', () => ({ companyProfileForPeriod: mocks.profile }))

import { getTaxReadiness } from './operations'

describe('persisted tax operations readiness', () => {
  beforeEach(() => {
    vi.stubEnv('TAX_GATEWAY_URL', 'https://gateway.example/api'); vi.stubEnv('TAX_GATEWAY_CREDENTIAL', 'gateway-secret-value')
    vi.stubEnv('ANNUAL_TAX_CALCULATOR_URL', 'https://calculator.example/api'); vi.stubEnv('ANNUAL_TAX_CALCULATOR_CREDENTIAL', 'calculator-secret-value')
    vi.stubEnv('TAX_PRODUCTION_FILING_ENABLED', 'true'); vi.stubEnv('TAX_GATEWAY_QUALIFICATION_ID', 'qualification-1'); vi.stubEnv('TAX_GATEWAY_QUALIFIED_FORM_VERSIONS', 'USTVA-2026.1')
    mocks.fiscalYear.mockResolvedValue({ id: 'fy-1', startsAt: new Date('2026-01-01'), endsAt: new Date('2026-12-31') })
    mocks.profile.mockResolvedValue({ chart: 'SKR04', vatRegime: 'STANDARD', vatFilingFrequency: 'MONTHLY' })
    mocks.mappings.mockResolvedValue([
      { effectiveFrom: new Date('2026-01-01'), effectiveTo: null, active: true, eBilanzPosition: 'bs.ass.currAss.receiv.other.vat' },
      { effectiveFrom: new Date('2026-01-01'), effectiveTo: null, active: true, eBilanzPosition: 'bs.eqLiab.liab.other.theroffTax.vat' },
    ])
    mocks.drafts.mockResolvedValue(0); mocks.sequence.mockResolvedValue({ nextValue: 42 }); mocks.onboarding.mockResolvedValue(null)
  })
  afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs() })

  it('keeps an otherwise ready tenant blocked when only the legacy sequence record exists', async () => {
    const report = await getTaxReadiness('tenant-a', 'USTVA', '2026-01')
    expect(report.ready).toBe(false)
    expect(report.checks.find(check => check.id === 'invoice-sequence')).toMatchObject({ ready: false, issues: [expect.stringMatching(/legacy sequence initialization/)] })
  })

  it('accepts matching durable reconciliation evidence for the tenant and year', async () => {
    mocks.onboarding.mockResolvedValue({ firstUnusedNumber: 42, importedCount: 3, importedNumbersHash: 'b'.repeat(64), confirmedBy: 'admin-a' })
    const report = await getTaxReadiness('tenant-a', 'USTVA', '2026-01')
    expect(report.ready).toBe(true)
    expect(report.checks.find(check => check.id === 'invoice-sequence')).toMatchObject({ ready: true, issues: [] })
  })

  it('checks draft entries only in the requested month for UStVA', async () => {
    mocks.onboarding.mockResolvedValue({ firstUnusedNumber: 42, importedCount: 3, importedNumbersHash: 'b'.repeat(64), confirmedBy: 'admin-a' })
    await getTaxReadiness('tenant-a', 'USTVA', '2026-02')
    expect(mocks.drafts).toHaveBeenCalledWith({ where: {
      fiscalYearId: 'fy-1', state: { not: 'POSTED' },
      bookingDate: { gte: new Date('2026-02-01T00:00:00.000Z'), lt: new Date('2026-03-01T00:00:00.000Z') },
    } })
  })

  it('checks the full fiscal year for annual declarations', async () => {
    mocks.profile.mockResolvedValue({ chart: 'SKR04', vatRegime: 'STANDARD', vatFilingFrequency: 'MONTHLY', annualTaxProfile: { tradeBusiness: true, establishments: 1, adviserExtension: false } })
    mocks.eBilanz.mockResolvedValue({ payloadHash: 'a', requestHash: 'b', resultXml: '<receipt/>' })
    await getTaxReadiness('tenant-a', 'KST', '2026')
    expect(mocks.drafts).toHaveBeenCalledWith({ where: { fiscalYearId: 'fy-1', state: { not: 'POSTED' } } })
  })
})
