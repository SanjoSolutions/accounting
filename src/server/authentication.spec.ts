import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  headers: vi.fn(async () => new Headers()),
  redirect: vi.fn((location: string) => {
    throw new Error(`redirect:${location}`)
  }),
}))

vi.mock('server-only', () => ({}))
vi.mock('./auth', () => ({
  auth: { api: { getSession: mocks.getSession } },
}))
vi.mock('next/headers', () => ({ headers: mocks.headers }))
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }))

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
      name: 'Local user',
      email: null,
    })
    expect(mocks.getSession).not.toHaveBeenCalled()
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
      name: 'Ada',
      email: 'ada@example.com',
    })
  })

  it('redirects protected pages when the credential session is missing', async () => {
    process.env.AUTH_MODE = 'credentials'
    mocks.getSession.mockResolvedValueOnce(null)

    await expect(requirePageUser()).rejects.toThrow('redirect:/sign-in')
    expect(mocks.redirect).toHaveBeenCalledWith('/sign-in')
  })
})
