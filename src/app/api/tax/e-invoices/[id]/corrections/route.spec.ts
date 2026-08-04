import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ correct: vi.fn(), template: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: vi.fn().mockResolvedValue({ id: 'tenant-a', actorId: 'user-a', role: 'ADMIN' }) }))
vi.mock('@/server/tax/structuredInvoices', async importOriginal => ({ ...(await importOriginal<typeof import('@/server/tax/structuredInvoices')>()), correctStructuredInvoice: mocks.correct, getOutgoingStructuredCorrectionTemplate: mocks.template }))
import { GET, POST } from './route'

describe('outgoing structured credit-note route', () => {
  beforeEach(() => vi.clearAllMocks())
  it('Given an authenticated tenant and explicit request key, when a credit note is posted, then the immutable target and body are tenant-scoped', async () => {
    mocks.correct.mockResolvedValue({ id: 'credit-a', invoiceNumber: '2026-000002' })
    const body = { kind: 'credit-note', requestKey: 'credit-route-request-01', issueDate: '2026-08-05', lines: [] }
    const response = await POST(new Request('http://localhost/api/tax/e-invoices/original/corrections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'original-a' }) })
    expect(response.status).toBe(201); expect(mocks.correct).toHaveBeenCalledWith('tenant-a', 'original-a', expect.objectContaining({ kind: 'credit-note', issueDate: '2026-08-05' }), 'credit-route-request-01')
  })
  it('returns only the tenant-owned correction template needed by the visible issuance form', async () => {
    mocks.template.mockResolvedValue({ data: { currency: 'EUR' }, buyerReference: 'REF' }); const response = await GET(new Request('http://localhost/api/tax/e-invoices/original/corrections'), { params: Promise.resolve({ id: 'original-a' }) }); expect(response.status).toBe(200); expect(mocks.template).toHaveBeenCalledWith('tenant-a', 'original-a')
  })
})
