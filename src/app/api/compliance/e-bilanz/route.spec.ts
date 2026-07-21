import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ user: vi.fn(), authorize: vi.fn(), overview: vi.fn(), prepare: vi.fn(), reconcile: vi.fn(), register: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/server/compliance/runtime', () => ({ authorizeComplianceTenant: mocks.authorize, complianceError: (error: unknown) => Response.json({ success: false, error: error instanceof Error ? error.message : 'failed' }, { status: 400 }) }))
vi.mock('@/server/compliance/eBilanzRepository', () => ({ getEBalanceLifecycleOverview: mocks.overview, prepareEBalanceLifecycleReport: mocks.prepare, recordEBalanceReconciliation: mocks.reconcile, registerEBalanceTaxonomy: mocks.register }))
import { GET, POST } from './route'

describe('authenticated E-Bilanz lifecycle API', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.user.mockResolvedValue({ id: 'user-1' }); mocks.authorize.mockResolvedValue('tenant-1') })
  it('keeps lifecycle reads tenant-scoped', async () => {
    mocks.overview.mockResolvedValue({ reports: [] })
    expect((await GET(new Request('http://local/api/compliance/e-bilanz?tenantId=tenant-1&fiscalYearId=fy-1'))).status).toBe(200)
    expect(mocks.authorize).toHaveBeenCalledWith('user-1', 'tenant-1'); expect(mocks.overview).toHaveBeenCalledWith('tenant-1', 'fy-1')
  })
  it('routes only explicit registry, reconciliation and report actions', async () => {
    for (const [action, mock] of [['taxonomy.register', mocks.register], ['reconciliation.record', mocks.reconcile], ['report.prepare', mocks.prepare]] as const) {
      mock.mockResolvedValue({ id: action }); const response = await POST(new Request('http://local/api/compliance/e-bilanz', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) })); expect(response.status).toBe(201); expect(mock).toHaveBeenCalled()
    }
    expect((await POST(new Request('http://local/api/compliance/e-bilanz', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"action":"delete"}' }))).status).toBe(400)
  })
  it('requires authentication before accessing lifecycle evidence', async () => { mocks.user.mockResolvedValue(null); expect((await GET(new Request('http://local/api/compliance/e-bilanz'))).status).toBe(401) })
})
