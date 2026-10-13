import { beforeEach, describe, expect, test, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ user: vi.fn(), authorize: vi.fn(), select: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/server/compliance/runtime', () => ({ authorizeComplianceTenant: mocks.authorize, complianceError: (error: Error) => Response.json({ error: error.message }, { status: 400 }) }))
vi.mock('@/server/hgbReviewPolicyRepository', () => ({ selectHgbReviewPolicy: mocks.select }))
import { PUT } from './route'
const request = (body: unknown) => new Request('http://127.0.0.1:3110/api/fiscal-years/2026/hgb-close/review-policy', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const params = { params: Promise.resolve({ year: '2026' }) }
describe('HGB policy route authorization', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.authorize.mockResolvedValue('owner'); mocks.user.mockResolvedValue({ id: 'owner', actorId: 'owner', role: 'ADMIN' }) })
  test.each([null, { id: 'owner', actorId: 'reader', role: 'READ_ONLY' }, { id: 'owner', actorId: 'accountant', role: 'ACCOUNTANT' }])('Given unauthenticated or non-admin actor %j, when policy selection is requested, then persistence is not called', async user => {
    mocks.user.mockResolvedValue(user)
    expect((await PUT(request({ expectedPolicyId: null }), params)).status).toBe(user ? 403 : 401)
    expect(mocks.select).not.toHaveBeenCalled()
  })
  test('Given an owner request, when authorized, then actor identity and exact policy version are supplied by the server', async () => {
    const policy = { mode: 'INDEPENDENT', reason: 'Second reviewer retained', evidenceIds: ['evidence'] }
    expect((await PUT(request({ tenantId: 'owner', actorId: 'forged', policy, expectedPolicyId: 'policy-1' }), params)).status).toBe(200)
    expect(mocks.select).toHaveBeenCalledWith('owner', 'owner', 2026, policy, 'policy-1')
  })
  test('Given tenant authorization fails or the revision is missing, when requested, then no policy is written', async () => {
    mocks.authorize.mockRejectedValueOnce(new Error('Tenant mismatch'))
    expect((await PUT(request({ tenantId: 'other', expectedPolicyId: null }), params)).status).toBe(400)
    expect((await PUT(request({}), params)).status).toBe(400)
    expect(mocks.select).not.toHaveBeenCalled()
  })
})
