import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ user: vi.fn(), prepare: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/server/tax/vatRepository', () => ({ prepareReconciledAnnualVatDataset: mocks.prepare }))
import { VatValidationError } from '@/core/vatEngine'
import { GET } from './route'

describe('annual VAT preparation route', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.user.mockResolvedValue({ id: 'tenant-a' }) })

  it('prepares the reconciled annual VAT dataset for the authenticated tenant', async () => {
    mocks.prepare.mockResolvedValue({ dataset: { kind: 'UST_ANNUAL', period: '2026' } })
    const response = await GET(new Request('http://localhost/api/tax/vat-annual?year=2026'))
    expect(response.status).toBe(200)
    expect(mocks.prepare).toHaveBeenCalledWith('tenant-a', 2026)
  })

  it('rejects malformed or unsupported years without preparing a dataset', async () => {
    mocks.prepare.mockRejectedValue(new VatValidationError(['Annual VAT preparation requires a four-digit calendar year.']))
    const response = await GET(new Request('http://localhost/api/tax/vat-annual?year=next'))
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ issues: [expect.stringMatching(/four-digit/)] })
  })

  it('requires authentication', async () => {
    mocks.user.mockResolvedValue(null)
    expect((await GET(new Request('http://localhost/api/tax/vat-annual?year=2026'))).status).toBe(401)
    expect(mocks.prepare).not.toHaveBeenCalled()
  })
})
