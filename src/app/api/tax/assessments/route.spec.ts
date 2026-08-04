import { describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ user: vi.fn(), record: vi.fn(), list: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/server/tax/workflows', () => ({ TaxGatewayConfigurationError: class extends Error {}, recordTaxAssessment: mocks.record, listTaxAssessments: mocks.list }))
import { POST } from './route'
describe('tax assessment route', () => {
  it('returns 400 for non-object JSON instead of dereferencing it', async () => {
    mocks.user.mockResolvedValue({ id: 'tenant-a', actorId: 'user-a', role: 'ADMIN' })
    expect((await POST(new Request('http://localhost/api/tax/assessments', { method: 'POST', body: 'null' }))).status).toBe(400)
    expect(mocks.record).not.toHaveBeenCalled()
  })
  it('binds assessments and their declaration drilldown to the authenticated tenant', async () => {
    mocks.user.mockResolvedValue({ id: 'tenant-a', actorId: 'user-a', role: 'ADMIN' }); mocks.record.mockResolvedValue({ id: 'assessment-1', differenceCents: 0 })
    const input = { id: 'assessment-1', taxpayerId: 'tenant-b', documentHash: 'untrusted-caller-value', kind: 'KST', period: '2026', assessedAmountCents: 1500, receivedAt: '2027-01-02', documentId: 'notice-document-1', noticeId: 'KSt-2026-1', authority: 'FINANZAMT', declarationSubmissionId: 'submission-1' }
    expect((await POST(new Request('http://localhost/api/tax/assessments', { method: 'POST', body: JSON.stringify(input) }))).status).toBe(201)
    const { taxpayerId: _, documentHash: _callerHash, ...tenantSafe } = input
    expect(mocks.record).toHaveBeenCalledWith('tenant-a', tenantSafe)
  })
})
