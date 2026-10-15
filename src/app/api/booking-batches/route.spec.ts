import { beforeEach, describe, expect, test, vi } from 'vitest'
import { ComplianceRuntimeError } from '@/server/compliance/runtime'

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getBookingBatches: vi.fn(),
  reviseBookingBatch: vi.fn(),
  postBookingBatch: vi.fn(),
}))

vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock('@/server/bookingBatches', async importOriginal => {
  const original = await importOriginal<typeof import('@/server/bookingBatches')>()
  return { ...original, getBookingBatches: mocks.getBookingBatches, reviseBookingBatch: mocks.reviseBookingBatch, postBookingBatch: mocks.postBookingBatch }
})

import { GET } from './route'
import { PATCH } from './[id]/route'
import { POST } from './[id]/post/route'

describe('booking batches API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getCurrentUser.mockResolvedValue({ id: 'tenant-a', actorId: 'actor-a', role: 'ADMIN' })
    mocks.reviseBookingBatch.mockResolvedValue({
      id: 'draft-a', version: 2, status: 'DRAFT', payload: JSON.stringify({ bookingDate: '2026-01-02', description: 'Reviewed', lines: [] }),
      createdAt: new Date('2026-08-11T09:00:00.000Z'), updatedAt: new Date('2026-08-11T10:00:00.000Z'),
    })
    mocks.postBookingBatch.mockResolvedValue({ id: 'entry-a', documentNumber: 'JOURNAL-entry-a' })
  })

  test('requires an authenticated tenant for batch reads', async () => {
    mocks.getCurrentUser.mockResolvedValue(null)
    const response = await GET(new Request('http://localhost/api/booking-batches?year=2026'))
    expect(response.status).toBe(401)
    expect(mocks.getBookingBatches).not.toHaveBeenCalled()
  })

  test('lists only the active tenant and requested fiscal year', async () => {
    const data = { fiscalYear: { year: 2026 }, accounts: [], drafts: [] }
    mocks.getBookingBatches.mockResolvedValue(data)
    const response = await GET(new Request('http://localhost/api/booking-batches?year=2026'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(data)
    expect(mocks.getBookingBatches).toHaveBeenCalledWith('tenant-a', '2026')
  })

  test('denies read-only revisions before parsing or mutating the request', async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: 'tenant-a', actorId: 'viewer-a', role: 'READ_ONLY' })
    const response = await PATCH(new Request('http://localhost/api/booking-batches/draft-a', { method: 'PATCH', body: '{' }), { params: Promise.resolve({ id: 'draft-a' }) })
    expect(response.status).toBe(403)
    expect(mocks.reviseBookingBatch).not.toHaveBeenCalled()
  })

  test('passes the optimistic version and editable posting to the revision workflow', async () => {
    const posting = { bookingDate: '2026-01-02', description: 'Reviewed', lines: [] }
    const response = await PATCH(json('/api/booking-batches/draft-a', { expectedVersion: 1, posting, reason: 'reviewed' }), { params: Promise.resolve({ id: 'draft-a' }) })
    expect(response.status).toBe(200)
    expect(mocks.reviseBookingBatch).toHaveBeenCalledWith('tenant-a', 'actor-a', 'draft-a', { expectedVersion: 1, posting, reason: 'reviewed' })
    expect(await response.json()).toMatchObject({
      id: 'draft-a', version: 2, status: 'DRAFT', updatedAt: '2026-08-11T10:00:00.000Z', posting,
    })
  })

  test('maps optimistic concurrency conflicts to a 409 response', async () => {
    mocks.reviseBookingBatch.mockRejectedValue(new ComplianceRuntimeError('Draft changed concurrently', 409))
    const response = await PATCH(json('/api/booking-batches/draft-a', { expectedVersion: 1, posting: {} }), { params: Promise.resolve({ id: 'draft-a' }) })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ success: false, error: 'Draft changed concurrently' })
  })

  test('posts a draft only through the explicit post endpoint', async () => {
    const response = await POST(new Request('http://localhost/api/booking-batches/draft-a/post', { method: 'POST' }), { params: Promise.resolve({ id: 'draft-a' }) })
    expect(response.status).toBe(200)
    expect(mocks.postBookingBatch).toHaveBeenCalledWith('tenant-a', 'actor-a', 'draft-a', undefined)
  })

  test('Given a read-only user, when posting, then access is denied before any draft mutation', async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: 'tenant-a', actorId: 'viewer-a', role: 'READ_ONLY' })
    const response = await POST(new Request('http://localhost/api/booking-batches/draft-a/post', { method: 'POST' }), { params: Promise.resolve({ id: 'draft-a' }) })
    expect(response.status).toBe(403)
    expect(mocks.postBookingBatch).not.toHaveBeenCalled()
  })

  test('Given an accountant, when posting a reviewed version, then tenant and actor are passed separately', async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: 'tenant-a', actorId: 'accountant-a', role: 'ACCOUNTANT' })
    const response = await POST(new Request('http://localhost/api/booking-batches/draft-a/post', { method: 'POST', body: JSON.stringify({ expectedVersion: 3 }) }), { params: Promise.resolve({ id: 'draft-a' }) })
    expect(response.status).toBe(200)
    expect(mocks.postBookingBatch).toHaveBeenCalledWith('tenant-a', 'accountant-a', 'draft-a', { expectedVersion: 3 })
  })
})

function json(path: string, body: unknown) {
  return new Request(`http://localhost${path}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}
