import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ user: vi.fn(), authorize: vi.fn(), create: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/server/compliance/historicalMappings', () => ({ createHistoricalMappingsForFiscalYear: mocks.create }))
vi.mock('@/server/compliance/runtime', () => ({ authorizeComplianceTenant: mocks.authorize, complianceError: (error: Error & { status?: number }) => Response.json({ success: false, error: error.message }, { status: error.status ?? 400 }) }))
import { POST } from './route'

describe('historical HGB mapping API', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.user.mockResolvedValue({ id: 'tenant-a', actorId: 'reviewer-a', role: 'ADMIN' }); mocks.authorize.mockResolvedValue('tenant-a'); mocks.create.mockResolvedValue([{ id: 'mapping-1' }]) })
  it('authorizes the selected tenant and uses the route fiscal year', async () => {
    const request = new Request('http://local/api/fiscal-years/2025/hgb-close/mappings', { method: 'POST', body: JSON.stringify({ tenantId: 'tenant-a', chartId: 'CUSTOM:HGB' }) })
    expect((await POST(request, { params: Promise.resolve({ year: '2025' }) })).status).toBe(201)
    expect(mocks.authorize).toHaveBeenCalledWith('tenant-a', 'tenant-a')
    expect(mocks.create).toHaveBeenCalledWith('tenant-a', 'reviewer-a', 2025, expect.objectContaining({ chartId: 'CUSTOM:HGB' }))
  })
})
