import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getCurrentUser: vi.fn(), deliver: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock('@/server/receivablesReminderRepository', () => ({ deliverReceivablesReminder: mocks.deliver }))

import { POST } from './route'

describe('POST /api/commercial/reminders/[id]/deliveries authorization and actor contract', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.getCurrentUser.mockResolvedValue({ id: 'tenant-a', actorId: 'human-actor', role: 'ACCOUNTANT' }); mocks.deliver.mockResolvedValue({ id: 'attempt-1', result: { status: 'SENT' } }) })
  it('Given an accountant approves an explicit recipient, when delivery is requested, then tenant and immutable human actor are passed separately', async () => {
    const body = { requestKey: 'delivery-request-0001', recipient: 'billing@example.de', reason: 'Reviewed customer address' }
    const response = await POST(new Request('http://localhost/api/commercial/reminders/r-1/deliveries', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'r-1' }) })
    expect(response.status).toBe(201); expect(mocks.deliver).toHaveBeenCalledWith('tenant-a', 'human-actor', 'r-1', body.requestKey, body)
  })
  it('Given a read-only user and malformed JSON, when delivery is attempted, then authorization rejects before parsing or provider work', async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: 'tenant-a', actorId: 'reader', role: 'READ_ONLY' })
    const response = await POST(new Request('http://localhost/api/commercial/reminders/r-1/deliveries', { method: 'POST', body: '{' }), { params: Promise.resolve({ id: 'r-1' }) })
    expect(response.status).toBe(403); expect(mocks.deliver).not.toHaveBeenCalled()
  })
  it('Given an unauthenticated request, when delivery is attempted, then it fails without parsing the body', async () => {
    mocks.getCurrentUser.mockResolvedValue(null)
    const response = await POST(new Request('http://localhost/api/commercial/reminders/r-1/deliveries', { method: 'POST', body: '{' }), { params: Promise.resolve({ id: 'r-1' }) })
    expect(response.status).toBe(401); expect(mocks.deliver).not.toHaveBeenCalled()
  })
})
