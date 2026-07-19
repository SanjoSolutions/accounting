import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ user: vi.fn(), applicability: vi.fn(), prepare: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/server/tax/annualRepository', () => ({ annualTaxApplicability: mocks.applicability, prepareAnnualTaxDatasets: mocks.prepare }))
import { GET, POST } from './route'

describe('annual tax production routes', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.user.mockResolvedValue({ id: 'tenant-a' }) })
  it('derives legal-form applicability and deadline from the authenticated company profile', async () => {
    mocks.applicability.mockResolvedValue({ kinds: ['KST', 'GEWST'], deadline: '2027-07-31' })
    const response = await GET(new Request('http://localhost/api/tax/annual?year=2026'))
    expect(response.status).toBe(200); expect(mocks.applicability).toHaveBeenCalledWith('tenant-a', 2026)
  })
  it('prepares reconciled annual declaration datasets only for the authenticated tenant', async () => {
    const values = [{ field: 'STEUERLICHES_ERGEBNIS', amountCents: 100, ledgerEntryIds: ['entry'], eBilanzFacts: ['fact'], adjustmentIds: [] }]
    mocks.prepare.mockResolvedValue({ datasets: [] })
    expect((await POST(request({ year: 2026, values }))).status).toBe(200)
    expect(mocks.prepare).toHaveBeenCalledWith('tenant-a', 2026, values)
  })
  it('returns 400 for malformed annual value elements', async () => {
    const response = await POST(request({ year: 2026, values: [null] }))
    expect(response.status).toBe(400)
    expect(mocks.prepare).not.toHaveBeenCalled()
  })
})
function request(body: unknown) { return new Request('http://localhost/api/tax/annual', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }
