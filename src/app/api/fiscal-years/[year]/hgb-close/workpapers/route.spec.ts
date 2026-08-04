import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(), authorizeComplianceTenant: vi.fn(), list: vi.fn(), save: vi.fn(), prepare: vi.fn(), review: vi.fn(), post: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock('@/server/compliance/runtime', () => ({ authorizeComplianceTenant: mocks.authorizeComplianceTenant, complianceError: (error: Error) => Response.json({ success: false, error: error.message }, { status: 400 }) }))
vi.mock('@/server/hgbWorkpaperRepository', () => ({ listHgbWorkpapers: mocks.list, saveHgbWorkpaper: mocks.save, prepareHgbWorkpaper: mocks.prepare, reviewHgbWorkpaper: mocks.review, postHgbAdjustment: mocks.post }))

import { GET, PUT } from './route'
import { POST as PREPARE } from './[id]/prepare/route'
import { POST as REVIEW } from './[id]/review/route'
import { POST as POST_ADJUSTMENT } from './[id]/adjustments/[proposalId]/post/route'

const params = Promise.resolve({ year: '2026' })
const request = (url: string, body?: object) => new Request(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined)

describe('HGB workpaper API', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.getCurrentUser.mockResolvedValue({ id: 'tenant-a', actorId: 'operator', role: 'ADMIN' }); mocks.authorizeComplianceTenant.mockResolvedValue('tenant-a') })

  it('tenant-authorizes list and typed save operations', async () => {
    mocks.list.mockResolvedValue({ workpapers: [] }); mocks.save.mockResolvedValue({ id: 'wp-1' })
    expect((await GET(request('http://localhost/api?tenantId=tenant-a'), { params })).status).toBe(200)
    expect(mocks.authorizeComplianceTenant).toHaveBeenCalledWith('tenant-a', 'tenant-a'); expect(mocks.list).toHaveBeenCalledWith('tenant-a', 2026)
    const response = await PUT(request('http://localhost/api', { tenantId: 'tenant-a', workpaper: { kind: 'GOING_CONCERN' }, expectedChecksum: 'old' }), { params })
    expect(response.status).toBe(200); expect(mocks.save).toHaveBeenCalledWith('tenant-a', 'operator', 2026, { kind: 'GOING_CONCERN' }, 'old')
  })

  it('uses the authenticated actor for preparation and independent review', async () => {
    mocks.prepare.mockResolvedValue({ status: 'PREPARED' }); mocks.review.mockResolvedValue({ status: 'REVIEWED' })
    await PREPARE(request('http://localhost/api', { tenantId: 'tenant-a', expectedChecksum: 'checksum' }), { params: Promise.resolve({ year: '2026', id: 'wp-1' }) })
    expect(mocks.prepare).toHaveBeenCalledWith('tenant-a', 'operator', 'wp-1', 'checksum')
    await REVIEW(request('http://localhost/api', { tenantId: 'tenant-a', decision: 'APPROVE' }), { params: Promise.resolve({ year: '2026', id: 'wp-1' }) })
    expect(mocks.review).toHaveBeenCalledWith('tenant-a', 'operator', 'wp-1', 'APPROVE', undefined)
  })

  it('passes route-bound workpaper and proposal identities to idempotent posting', async () => {
    mocks.post.mockResolvedValue({ status: 'POSTED', postedEntryId: 'entry-1' })
    const response = await POST_ADJUSTMENT(request('http://localhost/api', { tenantId: 'tenant-a', idempotencyKey: 'request-1' }), { params: Promise.resolve({ year: '2026', id: 'wp-1', proposalId: 'adj-1' }) })
    expect(response.status).toBe(200); expect(mocks.post).toHaveBeenCalledWith('tenant-a', 'operator', 2026, 'wp-1', 'adj-1', 'request-1')
  })

  it('rejects unauthenticated access before loading tenant workpapers', async () => {
    mocks.getCurrentUser.mockResolvedValue(null)
    expect((await GET(request('http://localhost/api?tenantId=tenant-a'), { params })).status).toBe(401)
    expect(mocks.list).not.toHaveBeenCalled()
  })
})
