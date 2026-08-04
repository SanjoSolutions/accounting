import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ user: vi.fn(), ensure: vi.fn(), dispose: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/server/ledger', () => ({ ensureLedger: mocks.ensure }))
vi.mock('@/server/fixedAssetsRepository', () => ({
  disposeFixedAsset: mocks.dispose,
  FixedAssetError: class FixedAssetError extends Error { constructor(message: string, readonly status = 400) { super(message) } },
}))
import { POST } from './route'

const request = (body: unknown) => new Request('http://localhost/api/fixed-assets/asset-a/disposals', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const input = { requestKey: 'retirement-request-0001', effectiveDate: '2026-03-15', evidenceDocumentId: 'evidence', disposalExpenseAccountId: 'loss-account', reason: 'Irreparably destroyed' }

describe('fixed-asset full-retirement API', () => {
  beforeEach(() => vi.clearAllMocks())

  it('Given an accountant acting in an assigned company, when full retirement is approved, then tenant and human actor remain distinct through the atomic repository boundary', async () => {
    mocks.user.mockResolvedValue({ id: 'tenant-a', actorId: 'accountant-user', role: 'ACCOUNTANT' }); mocks.dispose.mockResolvedValue({ event: { id: 'disposal-a' } })
    const response = await POST(request(input), { params: Promise.resolve({ id: 'asset-a' }) })
    expect(response.status).toBe(200)
    expect(mocks.ensure).toHaveBeenCalledWith('tenant-a', 2026)
    expect(mocks.dispose).toHaveBeenCalledWith('tenant-a', 'accountant-user', 'asset-a', input)
  })

  it('Given read-only access, when retirement is attempted, then it is rejected before request parsing, ledger setup, or persistence', async () => {
    mocks.user.mockResolvedValue({ id: 'tenant-a', actorId: 'viewer-user', role: 'READ_ONLY' })
    const response = await POST(new Request('http://localhost/api/fixed-assets/asset-a/disposals', { method: 'POST', body: '{invalid' }), { params: Promise.resolve({ id: 'asset-a' }) })
    expect(response.status).toBe(403)
    expect(mocks.ensure).not.toHaveBeenCalled(); expect(mocks.dispose).not.toHaveBeenCalled()
  })

  it('Given malformed JSON, when an authorized user submits retirement, then the API returns a controlled client error and creates nothing', async () => {
    mocks.user.mockResolvedValue({ id: 'tenant-a', actorId: 'admin-user', role: 'ADMIN' })
    const response = await POST(new Request('http://localhost/api/fixed-assets/asset-a/disposals', { method: 'POST', body: '{invalid' }), { params: Promise.resolve({ id: 'asset-a' }) })
    expect(response.status).toBe(400)
    expect(mocks.dispose).not.toHaveBeenCalled()
  })
})
