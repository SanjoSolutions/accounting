import { beforeEach, describe, expect, test, vi } from 'vitest'
import { AccountingValidationError } from '@/core/doubleEntry'

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(), createBookingBatch: vi.fn(), getLedgerWorkspace: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock('@/server/ledger', () => ({
  getLedgerWorkspace: mocks.getLedgerWorkspace,
}))
vi.mock('@/server/bookingBatches', () => ({ createBookingBatch: mocks.createBookingBatch }))
import { POST } from './route'

describe('posting API', () => {
  beforeEach(() => vi.clearAllMocks())

  test('rejects anonymous postings', async () => {
    mocks.getCurrentUser.mockResolvedValue(null)
    expect((await POST(request({}))).status).toBe(401)
  })

  test('Given a read-only user, when saving a booking, then no draft is created', async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: 'owner-1', actorId: 'viewer-1', role: 'READ_ONLY' })
    expect((await POST(request({}))).status).toBe(403)
    expect(mocks.createBookingBatch).not.toHaveBeenCalled()
  })

  test('returns all accounting validation issues', async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: 'owner-1', actorId: 'user-1', role: 'ADMIN' })
    mocks.createBookingBatch.mockRejectedValue(new AccountingValidationError(['Soll und Haben stimmen nicht überein.']))
    const response = await POST(request({ lines: [] }))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ issues: ['Soll und Haben stimmen nicht überein.'] })
  })

  test('creates an editable draft for the owner without posting to the journal', async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: 'owner-1', actorId: 'user-1', role: 'ADMIN' })
    mocks.createBookingBatch.mockResolvedValue({ id: 'draft-1', status: 'DRAFT', version: 1 })
    const body = { fiscalYear: 2026, bookingDate: '2026-01-01', description: 'Test', lines: [], documentIds: ['document-1', 'document-2'] }
    const response = await POST(request(body))
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ id: 'draft-1', status: 'DRAFT' })
    expect(mocks.createBookingBatch).toHaveBeenCalledWith('owner-1', 'user-1', body)
  })

  test('returns 400 for malformed JSON instead of an internal error', async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: 'owner-1', actorId: 'user-1', role: 'ADMIN' })
    const response = await POST(new Request('http://localhost/api/booking-records', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
    }))
    expect(response.status).toBe(400)
  })
})

function request(body: unknown) {
  return new Request('http://localhost/api/booking-records', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}
