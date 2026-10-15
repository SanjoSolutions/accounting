import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ user: vi.fn(), authorize: vi.fn(), overview: vi.fn(), prepare: vi.fn(), reconcile: vi.fn(), register: vi.fn(), approve: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/server/compliance/runtime', () => ({ authorizeComplianceTenant: mocks.authorize, complianceError: (error: unknown) => Response.json({ success: false, error: error instanceof Error ? error.message : 'failed' }, { status: 400 }) }))
vi.mock('@/server/compliance/eBilanzRepository', () => ({ getEBalanceLifecycleOverview: mocks.overview, prepareEBalanceLifecycleReport: mocks.prepare, recordEBalanceReconciliation: mocks.reconcile, registerEBalanceTaxonomy: mocks.register }))
vi.mock('@/server/compliance/eBilanzReportActions', () => ({ approveEBalanceReport: mocks.approve }))
import { GET, POST } from './route'

describe('authenticated E-Bilanz lifecycle API', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.user.mockResolvedValue({ id: 'tenant-1', actorId: 'user-1', role: 'ADMIN' }); mocks.authorize.mockResolvedValue('tenant-1') })
  test('given an authenticated tenant, keeps lifecycle reads tenant-scoped', async () => {
    mocks.overview.mockResolvedValue({ reports: [] })
    expect((await GET(new Request('http://local/api/compliance/e-bilanz?tenantId=tenant-1&fiscalYearId=fy-1'))).status).toBe(200)
    expect(mocks.authorize).toHaveBeenCalledWith('tenant-1', 'tenant-1'); expect(mocks.overview).toHaveBeenCalledWith('tenant-1', 'fy-1')
  })
  test('given explicit actions, routes registry, reconciliation, preparation and approval requests', async () => {
    for (const [action, mock] of [['taxonomy.register', mocks.register], ['reconciliation.record', mocks.reconcile], ['report.prepare', mocks.prepare], ['report.approve', mocks.approve]] as const) {
      mock.mockResolvedValue({ id: action }); const response = await POST(new Request('http://local/api/compliance/e-bilanz', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) })); expect(response.status).toBe(201); expect(mock).toHaveBeenCalled()
    }
    expect((await POST(new Request('http://local/api/compliance/e-bilanz', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"action":"delete"}' }))).status).toBe(400)
  })
  test('given no session, requires authentication before accessing lifecycle evidence', async () => { mocks.user.mockResolvedValue(null); expect((await GET(new Request('http://local/api/compliance/e-bilanz'))).status).toBe(401) })
  test('given a delegated accountant, preserves owner and actor for exact-version approval', async () => {
    const body = { action: 'report.approve', reportId: 'report', reportChecksum: 'checksum', confirmed: true, reason: 'Reviewed' }
    expect((await POST(new Request('http://local/api/compliance/e-bilanz', { method: 'POST', body: JSON.stringify(body) }))).status).toBe(201)
    expect(mocks.approve).toHaveBeenCalledWith('tenant-1', 'user-1', body)
  })
  test('given a read-only member, rejects approval before invoking persistence', async () => {
    mocks.user.mockResolvedValue({ id: 'tenant-1', actorId: 'reader', role: 'READ_ONLY' })
    expect((await POST(new Request('http://local/api/compliance/e-bilanz', { method: 'POST', body: '{"action":"report.approve"}' }))).status).toBe(403)
    expect(mocks.approve).not.toHaveBeenCalled()
  })
})
