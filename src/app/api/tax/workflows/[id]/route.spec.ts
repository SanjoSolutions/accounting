import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ user: vi.fn(), cancel: vi.fn(), correct: vi.fn(), recover: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/server/tax/workflows', () => ({ cancelTaxWorkflow: mocks.cancel, correctTaxWorkflow: mocks.correct, recoverTaxWorkflow: mocks.recover }))

import { POST } from './route'

describe('tax correction and uncertain-outcome routes', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.user.mockResolvedValue({ id: 'tenant-a' }) })
  it('tenant-scopes an explicitly approved correction', async () => {
    mocks.correct.mockResolvedValue({ submissionId: 'correction-1' })
    const dataset = { kind: 'KST', period: '2026', fields: { STEUERLICHES_ERGEBNIS: 100, KST_SCHULD: 15 } }
    const response = await POST(request({ action: 'correct', confirmed: true, requestKey: 'correction-key-001', dataset }), { params: Promise.resolve({ id: 'original-1' }) })
    expect(response.status).toBe(201)
    expect(mocks.correct).toHaveBeenCalledWith('tenant-a', 'tenant-a', 'original-1', 'correction-key-001', dataset)
  })
  it('exposes explicit recovery for an uncertain official outcome', async () => {
    mocks.recover.mockResolvedValue({ submissionId: 'submission-1', state: 'accepted' })
    expect((await POST(request({ action: 'recover', confirmed: true }), { params: Promise.resolve({ id: 'submission-1' }) })).status).toBe(200)
    expect(mocks.recover).toHaveBeenCalledWith('tenant-a', 'submission-1')
  })
})
function request(body: unknown) { return new Request('http://localhost/api/tax/workflows/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }
