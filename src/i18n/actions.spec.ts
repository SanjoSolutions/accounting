import { beforeEach, describe, expect, it, vi } from 'vitest'
import { localeCookieName } from './config'

const setCookie = vi.fn()

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ set: setCookie })),
}))

import { setLocale } from './actions'

describe('setLocale', () => {
  beforeEach(() => {
    setCookie.mockClear()
  })

  it('stores a supported locale in a site-wide preference cookie', async () => {
    await setLocale('en')

    expect(setCookie).toHaveBeenCalledWith(localeCookieName, 'en', {
      httpOnly: true,
      maxAge: 60 * 60 * 24 * 365,
      sameSite: 'lax',
      path: '/',
    })
  })

  it('rejects unsupported locales without changing the preference', async () => {
    await expect(setLocale('fr')).rejects.toThrow('Unsupported locale: fr')
    expect(setCookie).not.toHaveBeenCalled()
  })
})
