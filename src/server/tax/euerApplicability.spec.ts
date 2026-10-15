import { describe, expect, test, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ profile: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/persistence/client', () => ({ prisma: { fiscalYear: { findFirst: async () => ({ startsAt: new Date('2026-01-01'), endsAt: new Date('2026-12-31') }) } } }))
vi.mock('./profileRepository', () => ({ companyProfileForPeriod: mocks.profile }))
import { annualTaxApplicability } from './annualRepository'

describe('EÜR annual-tax applicability', () => {
  test('Given explicit EÜR facts and obsolete corporate facts, when determining returns, then balance-sheet tax preparation is excluded and EÜR remains manual', async () => {
    mocks.profile.mockResolvedValue({
      legalForm: 'SOLE_TRADER', vatRegime: 'STANDARD',
      soleTraderTaxProfile: { profitDetermination: 'EUER', incomeType: 'SELF_EMPLOYED', euerEligibilityConfirmed: true },
      annualTaxProfile: { tradeBusiness: true, establishments: 1, adviserExtension: false },
    })
    expect(await annualTaxApplicability('sole-trader', 2026)).toMatchObject({ profile: undefined, kinds: ['UST_ANNUAL'], euer: { incomeType: 'SELF_EMPLOYED', manualPreparation: true } })
  })
})
