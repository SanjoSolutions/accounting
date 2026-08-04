import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  headers: vi.fn(async () => new Headers()),
  redirect: vi.fn((location: string) => {
    throw new Error(`redirect:${location}`)
  }),
  membership: vi.fn(),
}))

vi.mock('server-only', () => ({}))
vi.mock('./auth', () => ({
  auth: { api: { getSession: mocks.getSession } },
}))
vi.mock('next/headers', () => ({ headers: mocks.headers }))
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }))
vi.mock('./persistence/client', () => ({ prisma: { tenantMembership: { findUnique: mocks.membership } } }))

import { getCurrentUser, requirePageUser } from './authentication'

const originalAuthMode = process.env.AUTH_MODE

describe('authentication boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterAll(() => {
    if (originalAuthMode === undefined) delete process.env.AUTH_MODE
    else process.env.AUTH_MODE = originalAuthMode
  })

  it('allows the synthetic local user without consulting Better Auth', async () => {
    process.env.AUTH_MODE = 'none'

    await expect(getCurrentUser(new Headers())).resolves.toEqual({
      id: 'local',
      actorId: 'local',
      name: 'Local user',
      email: null,
      role: 'ADMIN',
    })
    expect(mocks.getSession).not.toHaveBeenCalled()
    expect(mocks.membership).not.toHaveBeenCalled()
  })

  it('requires a Better Auth session in credential mode', async () => {
    process.env.AUTH_MODE = 'credentials'
    mocks.getSession.mockResolvedValueOnce(null)
    await expect(getCurrentUser(new Headers())).resolves.toBeNull()

    mocks.getSession.mockResolvedValueOnce({
      user: { id: 'user-1', name: 'Ada', email: 'ada@example.com' },
    })
    await expect(getCurrentUser(new Headers())).resolves.toEqual({
      id: 'user-1',
      actorId: 'user-1',
      name: 'Ada',
      email: 'ada@example.com',
      role: 'ADMIN',
    })
  })

  it('resolves an explicitly assigned active tenant while retaining the human actor identity', async () => {
    process.env.AUTH_MODE = 'credentials'
    mocks.getSession.mockResolvedValueOnce({ user: { id: 'reader-1', name: 'Rita', email: 'rita@example.com' } })
    mocks.membership.mockResolvedValueOnce({ role: 'READ_ONLY' })
    const headers = new Headers({ cookie: 'accounting-tenant=company-owner' })
    await expect(getCurrentUser(headers)).resolves.toMatchObject({ id: 'company-owner', actorId: 'reader-1', role: 'READ_ONLY' })
    expect(mocks.membership).toHaveBeenCalledWith(expect.objectContaining({ where: { ownerId_userId: { ownerId: 'company-owner', userId: 'reader-1' } } }))
  })

  it('fails closed to the actor own tenant when a forged active-tenant cookie has no membership', async () => {
    process.env.AUTH_MODE = 'credentials'
    mocks.getSession.mockResolvedValueOnce({ user: { id: 'user-1', name: 'Ada', email: 'ada@example.com' } })
    mocks.membership.mockResolvedValueOnce(null)
    await expect(getCurrentUser(new Headers({ cookie: 'accounting-tenant=other-company' }))).resolves.toMatchObject({ id: 'user-1', actorId: 'user-1', role: 'ADMIN' })
  })

  it('redirects protected pages when the credential session is missing', async () => {
    process.env.AUTH_MODE = 'credentials'
    mocks.getSession.mockResolvedValueOnce(null)

    await expect(requirePageUser()).rejects.toThrow('redirect:/sign-in')
    expect(mocks.redirect).toHaveBeenCalledWith('/sign-in')
  })
})
