import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ user: vi.fn(), ensure: vi.fn(), sell: vi.fn() }))
const FixedAssetErrorMock = vi.hoisted(() => class FixedAssetError extends Error { constructor(message: string, readonly status = 400) { super(message) } })
vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/server/ledger', () => ({ ensureLedger: mocks.ensure }))
vi.mock('@/server/fixedAssetsRepository', () => ({ sellFixedAsset: mocks.sell, FixedAssetError: FixedAssetErrorMock }))
import { POST } from './route'

const input = { requestKey: 'asset-sale-request-0001', effectiveDate: '2026-02-15', evidenceDocumentId: 'sale-evidence', netProceedsCents: 10_000, vatRateBasisPoints: 1900, businessPartnerId: 'customer-a', invoiceNumber: 'SALE-2026-001', receivableAccountId: 'receivable', proceedsAccountId: 'gain-proceeds', carryingValueAccountId: 'gain-carrying', outputVatAccountId: 'output-vat', reason: 'Management approved domestic sale' }
const request = (body: unknown) => new Request('http://localhost/api/fixed-assets/asset-a/sales', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('fixed-asset full-sale API', () => {
  beforeEach(() => vi.clearAllMocks())

  it('Given an accountant acting in an assigned company, when an evidenced sale is approved, then tenant and human actor remain distinct at the atomic repository boundary', async () => {
    mocks.user.mockResolvedValue({ id: 'tenant-a', actorId: 'accountant-a', role: 'ACCOUNTANT' }); mocks.sell.mockResolvedValue({ event: { id: 'sale-a' } })
    const response = await POST(request(input), { params: Promise.resolve({ id: 'asset-a' }) })
    expect(response.status).toBe(200); expect(mocks.ensure).toHaveBeenCalledWith('tenant-a', 2026); expect(mocks.sell).toHaveBeenCalledWith('tenant-a', 'accountant-a', 'asset-a', input)
  })

  it('Given read-only access, when a sale is attempted, then it is forbidden before parsing, ledger setup, or persistence', async () => {
    mocks.user.mockResolvedValue({ id: 'tenant-a', actorId: 'viewer-a', role: 'READ_ONLY' })
    const response = await POST(new Request('http://localhost/api/fixed-assets/asset-a/sales', { method: 'POST', body: '{invalid' }), { params: Promise.resolve({ id: 'asset-a' }) })
    expect(response.status).toBe(403); expect(mocks.ensure).not.toHaveBeenCalled(); expect(mocks.sell).not.toHaveBeenCalled()
  })

  it('Given malformed JSON, when an administrator submits a sale, then a controlled client error is returned and nothing is persisted', async () => {
    mocks.user.mockResolvedValue({ id: 'tenant-a', actorId: 'admin-a', role: 'ADMIN' })
    const response = await POST(new Request('http://localhost/api/fixed-assets/asset-a/sales', { method: 'POST', body: '{invalid' }), { params: Promise.resolve({ id: 'asset-a' }) })
    expect(response.status).toBe(400); expect(mocks.sell).not.toHaveBeenCalled()
  })

  it('Given a duplicate sale invoice identity, when the repository rejects it, then the API returns a controlled conflict instead of leaking a database failure', async () => {
    mocks.user.mockResolvedValue({ id: 'tenant-a', actorId: 'accountant-a', role: 'ACCOUNTANT' }); mocks.sell.mockRejectedValue(new FixedAssetErrorMock('The sale invoice number is already used by another tenant receivable.', 409))
    const response = await POST(request(input), { params: Promise.resolve({ id: 'asset-a' }) })
    expect(response.status).toBe(409); await expect(response.json()).resolves.toMatchObject({ success: false, error: expect.stringMatching(/invoice number.*already used/) })
  })
})
