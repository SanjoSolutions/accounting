import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getCurrentUser: vi.fn(), authorize: vi.fn(), getRuns: vi.fn(), evaluate: vi.fn(), complianceError: vi.fn(() => Response.json({ success: false }, { status: 400 })) }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock('@/server/compliance/runtime', () => ({ complianceError: mocks.complianceError, authorizeComplianceTenant: mocks.authorize }))
vi.mock('@/server/hgbCloseRepository', () => ({ getHgbCloseRuns: mocks.getRuns, evaluateAndPersistHgbClose: mocks.evaluate }))

import { GET, POST } from './route'

const context = { params: Promise.resolve({ year: '2026' }) }
const json = (body: unknown) => new Request('http://localhost/api/fiscal-years/2026/hgb-close', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('HGB close run API', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.getCurrentUser.mockResolvedValue({ id: 'tenant-a', actorId: 'user-a', role: 'ADMIN' }); mocks.authorize.mockResolvedValue('tenant-a'); mocks.getRuns.mockResolvedValue({ runs: [] }); mocks.evaluate.mockResolvedValue({ id: 'run-1', status: 'BLOCKED' }) })

  it('requires authentication for reading and evaluating close runs', async () => {
    mocks.getCurrentUser.mockResolvedValue(null)
    expect((await GET(new Request('http://localhost/api/fiscal-years/2026/hgb-close'), context)).status).toBe(401)
    expect((await POST(json({}), context)).status).toBe(401)
  })

  it('uses the authenticated tenant and route year instead of caller ownership or period fields', async () => {
    await GET(new Request('http://localhost/api/fiscal-years/2026/hgb-close'), context)
    const response = await POST(json({ ownerId: 'tenant-b', fiscalPeriodStart: '1999-01-01', reason: 'evaluate' }), context)
    expect(response.status).toBe(201)
    expect(mocks.getRuns).toHaveBeenCalledWith('tenant-a', 2026)
    expect(mocks.evaluate).toHaveBeenCalledWith('tenant-a', 'user-a', 2026, expect.objectContaining({ ownerId: 'tenant-b' }))
  })

  it('rejects non-object request bodies before persistence', async () => {
    expect((await POST(json([]), context)).status).toBe(400)
    expect(mocks.evaluate).not.toHaveBeenCalled()
  })
})
