import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getSettings: vi.fn(async () => ({ id: 'default' })),
  updateSettings: vi.fn(),
}))

vi.mock('server-only', () => ({}))
vi.mock('@/server/auth', () => ({
  auth: { api: { getSession: mocks.getSession } },
}))
vi.mock('@/server', () => ({
  getSettings: mocks.getSettings,
  updateSettings: mocks.updateSettings,
}))

import { GET, PUT } from './route'

const originalAuthMode = process.env.AUTH_MODE

describe('settings API authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterAll(() => {
    if (originalAuthMode === undefined) delete process.env.AUTH_MODE
    else process.env.AUTH_MODE = originalAuthMode
  })

  it('remains available in local no-auth mode', async () => {
    process.env.AUTH_MODE = 'none'

    const response = await GET(new Request('http://localhost/api/settings'))

    expect(response.status).toBe(200)
    expect(mocks.getSettings).toHaveBeenCalledOnce()
    expect(mocks.getSession).not.toHaveBeenCalled()
  })

  it('rejects an anonymous request in credential mode', async () => {
    process.env.AUTH_MODE = 'credentials'
    mocks.getSession.mockResolvedValueOnce(null)

    const response = await GET(new Request('http://localhost/api/settings'))

    expect(response.status).toBe(401)
    expect(mocks.getSettings).not.toHaveBeenCalled()
  })

  it('allows an authenticated request in credential mode', async () => {
    process.env.AUTH_MODE = 'credentials'
    mocks.getSession.mockResolvedValueOnce({
      user: { id: 'user-1', name: 'Ada', email: 'ada@example.com' },
    })

    const response = await GET(new Request('http://localhost/api/settings'))

    expect(response.status).toBe(200)
    expect(mocks.getSettings).toHaveBeenCalledOnce()
  })

  it('saves SKR04 as the selected chart of accounts', async () => {
    process.env.AUTH_MODE = 'none'
    const settings = {
      chartOfAccounts: 'SKR04',
      invoiceIssuer: { name: 'Example GmbH' },
    }

    const response = await PUT(new Request('http://localhost/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    }))

    expect(response.status).toBe(200)
    expect(mocks.updateSettings).toHaveBeenCalledWith(settings)
  })

  it('rejects an unsupported chart of accounts', async () => {
    process.env.AUTH_MODE = 'none'

    const response = await PUT(new Request('http://localhost/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chartOfAccounts: 'SKR05' }),
    }))

    expect(response.status).toBe(400)
    expect(mocks.updateSettings).not.toHaveBeenCalled()
  })
})
