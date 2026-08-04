import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ current: vi.fn(), listAccess: vi.fn(), listTenants: vi.fn(), setMember: vi.fn(), removeMember: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.current }))
vi.mock('@/server/tenantAccess', () => ({
  listTenantAccess: mocks.listAccess, listAvailableTenants: mocks.listTenants,
  setTenantMember: mocks.setMember, removeTenantMember: mocks.removeMember,
  TenantAccessError: class TenantAccessError extends Error { constructor(message: string, readonly status = 400) { super(message) } },
}))

import { GET, POST } from './route'

describe('tenant access API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.current.mockResolvedValue({ id: 'tenant-a', actorId: 'admin-a', name: 'Admin', email: 'admin@example.test', role: 'ADMIN' })
    mocks.listAccess.mockResolvedValue({ activeTenantId: 'tenant-a', members: [] })
    mocks.listTenants.mockResolvedValue([{ ownerId: 'tenant-a', role: 'ADMIN' }])
  })

  it('Given an authenticated member, when access context is read, then only the server-resolved tenant and actor context is returned', async () => {
    const response = await GET(new Request('http://localhost/api/access?ownerId=tenant-b'))
    expect(response.status).toBe(200)
    expect(mocks.listAccess).toHaveBeenCalledWith(expect.objectContaining({ id: 'tenant-a', actorId: 'admin-a' }))
    expect(mocks.listTenants).toHaveBeenCalledWith('admin-a')
  })

  it('Given a read-only member, when a role change is attempted, then the API returns 403 without writing', async () => {
    mocks.current.mockResolvedValue({ id: 'tenant-a', actorId: 'reader-a', role: 'READ_ONLY' })
    const response = await POST(json({ email: 'other@example.test', role: 'ADMIN', reason: 'Escalate' }))
    expect(response.status).toBe(403)
    expect(mocks.setMember).not.toHaveBeenCalled()
  })

  it('Given an administrator, when a role is assigned, then tenant and actor IDs come only from the authorized principal', async () => {
    mocks.setMember.mockResolvedValue({ userId: 'reader-a', role: 'READ_ONLY' })
    const response = await POST(json({ ownerId: 'tenant-b', actorId: 'forged', email: 'reader@example.test', role: 'READ_ONLY', reason: 'Review annual accounts' }))
    expect(response.status).toBe(200)
    expect(mocks.setMember).toHaveBeenCalledWith('tenant-a', 'admin-a', 'reader@example.test', 'READ_ONLY', 'Review annual accounts')
  })
})

function json(body: unknown) { return new Request('http://localhost/api/access', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }
