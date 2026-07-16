import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { GET, POST } from './route'

const originalAuthMode = process.env.AUTH_MODE
const originalDisableSignUp = process.env.BETTER_AUTH_DISABLE_SIGN_UP

describe('Better Auth route availability', () => {
  beforeEach(() => {
    delete process.env.BETTER_AUTH_DISABLE_SIGN_UP
  })

  afterAll(() => {
    if (originalAuthMode === undefined) delete process.env.AUTH_MODE
    else process.env.AUTH_MODE = originalAuthMode
    if (originalDisableSignUp === undefined) delete process.env.BETTER_AUTH_DISABLE_SIGN_UP
    else process.env.BETTER_AUTH_DISABLE_SIGN_UP = originalDisableSignUp
  })

  it('does not expose Better Auth endpoints in local no-auth mode', async () => {
    process.env.AUTH_MODE = 'none'

    const response = await GET(new Request('http://localhost/api/auth/get-session'))

    expect(response.status).toBe(404)
  })

  it('blocks credential registration when sign-up is disabled', async () => {
    process.env.AUTH_MODE = 'credentials'
    process.env.BETTER_AUTH_DISABLE_SIGN_UP = 'true'

    const response = await POST(new Request('http://localhost/api/auth/sign-up/email', {
      method: 'POST',
    }))

    expect(response.status).toBe(403)
  })
})
