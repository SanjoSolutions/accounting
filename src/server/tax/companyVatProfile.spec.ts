import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ versions: vi.fn(), account: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/persistence/client', () => ({ prisma: { companyProfileVersion: { findMany: mocks.versions }, accountRecord: { findUnique: mocks.account } } }))
import { companyVatRegimeAt } from './companyVatProfile'

const profile = { companyName: 'Synthetic UG', legalForm: 'UG', taxNumber: '12/345/67890', taxOffice: 'Berlin', vatRegime: 'SMALL_BUSINESS', vatFilingFrequency: 'ANNUAL', activity: 'Consulting', sizeClass: 'MICRO', chart: 'SKR03', elections: [] }
describe('effective company VAT regime', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.versions.mockResolvedValue([]); mocks.account.mockResolvedValue(null) })

  test('Given a legacy standard tenant, when no dated profile exists, then existing standard behavior remains available', async () => {
    await expect(companyVatRegimeAt('tenant', '2026-05-01')).resolves.toBe('STANDARD')
    expect(mocks.versions).toHaveBeenCalledWith(expect.objectContaining({ where: { ownerId: 'tenant' } }))
  })
  test('Given an undated small-business selection, when posting is requested, then explicit effective-date confirmation is required', async () => {
    mocks.account.mockResolvedValue({ payload: JSON.stringify({ companyProfile: profile }) })
    await expect(companyVatRegimeAt('tenant', '2026-05-01')).rejects.toThrow(/Confirm the effective date/)
  })
  test('Given a non-German small-business profile, when domestic §19 treatment is requested, then unsupported cross-border qualification is rejected', async () => {
    mocks.versions.mockResolvedValue([{ effectiveFrom: new Date('2026-01-01'), effectiveTo: null, payload: JSON.stringify({ ...profile, registeredAddress: { streetAndHouseNumber: 'Test 1', zipCode: '1010', city: 'Vienna', country: 'AT' } }) }])
    await expect(companyVatRegimeAt('tenant', '2026-05-01')).rejects.toThrow(/German company profile/)
  })
  test('Given an impossible date, when a VAT profile is requested, then no persistence lookup occurs', async () => {
    await expect(companyVatRegimeAt('tenant', '2026-02-30')).rejects.toThrow(/real VAT effective date/)
    expect(mocks.versions).not.toHaveBeenCalled()
  })
})
