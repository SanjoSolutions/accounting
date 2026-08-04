import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ user: vi.fn(), authorize: vi.fn(), create: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/server/compliance/historicalProfile', () => ({ createHistoricalProfileForFiscalYear: mocks.create }))
vi.mock('@/server/compliance/runtime', () => ({ authorizeComplianceTenant: mocks.authorize, complianceError: (error: Error & { status?: number }) => Response.json({ success: false, error: error.message }, { status: error.status ?? 400 }) }))
import { POST } from './route'

describe('historical HGB profile API', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.user.mockResolvedValue({ id: 'tenant-a', actorId: 'user-a', role: 'ADMIN' }); mocks.authorize.mockResolvedValue('tenant-a'); mocks.create.mockResolvedValue({ id: 'profile-1' }) })
  it('uses the authenticated tenant and route fiscal year', async () => {
    const response = await POST(new Request('http://local/api/fiscal-years/2025/hgb-close/profile', { method: 'POST', body: JSON.stringify({ profile: {}, reason: 'x', evidenceId: 'e' }) }), { params: Promise.resolve({ year: '2025' }) })
    expect(response.status).toBe(201); expect(mocks.create).toHaveBeenCalledWith('tenant-a', 'user-a', 2025, expect.objectContaining({ reason: 'x' }))
  })
  it('rejects unauthenticated and malformed requests', async () => {
    mocks.user.mockResolvedValueOnce(null)
    expect((await POST(new Request('http://local', { method: 'POST' }), { params: Promise.resolve({ year: '2025' }) })).status).toBe(401)
    expect((await POST(new Request('http://local', { method: 'POST', body: '[]' }), { params: Promise.resolve({ year: 'nope' }) })).status).toBe(400)
  })
})
