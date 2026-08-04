import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getCurrentUser: vi.fn(), getContext: vi.fn(), post: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock('@/server/incomingInvoicePosting', () => ({
  getIncomingInvoicePostingContext: mocks.getContext,
  postConfirmedIncomingInvoice: mocks.post,
  IncomingInvoicePostingError: class IncomingInvoicePostingError extends Error { constructor(message: string, readonly status = 400) { super(message) } },
}))
import { GET, POST } from './route'

describe('incoming supplier invoice posting API', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects anonymous access before reading posting context', async () => {
    mocks.getCurrentUser.mockResolvedValue(null)
    const response = await GET(new Request('http://localhost/api/documents/doc-1/payable-posting'), args())
    expect(response.status).toBe(401); expect(mocks.getContext).not.toHaveBeenCalled()
  })

  it('scopes expense-account context to the authenticated tenant and confirmed document', async () => {
    const context = { posting: null, expenseAccounts: [{ id: 'office', number: 4930, name: 'Bürobedarf' }], recommendedExpenseAccountId: 'office' }
    mocks.getCurrentUser.mockResolvedValue({ id: 'tenant-a', actorId: 'user-a', role: 'ADMIN' }); mocks.getContext.mockResolvedValue(context)
    const response = await GET(new Request('http://localhost/api/documents/doc-1/payable-posting'), args())
    expect(response.status).toBe(200); expect(mocks.getContext).toHaveBeenCalledWith('tenant-a', 'doc-1')
    await expect(response.json()).resolves.toEqual({ success: true, data: context })
  })

  it('posts only with the authenticated actor and explicit review choices', async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: 'tenant-a', role: 'ADMIN' }); mocks.post.mockResolvedValue({ id: 'payable-1' })
    const input = { expenseAccountId: 'expense-a', dueDate: '2026-08-06', reason: 'Reviewed and approved', reverseChargeRateBasisPoints: 1900, reverseChargeSupplyKind: 'SERVICE' }
    const response = await POST(new Request('http://localhost/api/documents/doc-1/payable-posting', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }), args())
    expect(response.status).toBe(200); expect(mocks.post).toHaveBeenCalledWith('tenant-a', 'tenant-a', 'doc-1', input)
  })

  it('Given an EU-service treatment, when context is requested, then its distinct classification and fail-closed control readiness cross the authenticated API unchanged', async () => {
    const context = { posting: null, expenseAccounts: [], recommendedExpenseAccountId: null, reverseChargeTreatment: { kind: 'DE_13B_EU_SERVICE', supportedAssessmentRatesBasisPoints: [1900], reason: 'UStG §3a(2), §13b(1); VAT Directive Article 196', configured: false } }
    mocks.getCurrentUser.mockResolvedValue({ id: 'tenant-a', actorId: 'user-a', role: 'ACCOUNTANT' }); mocks.getContext.mockResolvedValue(context)
    const response = await GET(new Request('http://localhost/api/documents/eu-service/payable-posting'), { params: Promise.resolve({ id: 'eu-service' }) })
    expect(response.status).toBe(200); expect(mocks.getContext).toHaveBeenCalledWith('tenant-a', 'eu-service')
    await expect(response.json()).resolves.toEqual({ success: true, data: context })
  })
})

function args() { return { params: Promise.resolve({ id: 'doc-1' }) } }
