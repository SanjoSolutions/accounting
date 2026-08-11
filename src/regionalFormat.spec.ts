import { beforeEach, describe, expect, test, vi } from 'vitest'
import { regionalFormatCookieName } from './regionalFormat'

const setCookie = vi.fn()

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ set: setCookie })),
}))

import { setRegionalFormat } from './regionalFormatActions'
import { regionalFormats, regionalLocaleFor, resolveBrowserRegionalLocale, resolveRegionalFormat, resolveServerRegionalLocale } from './regionalFormat'

describe('regional format preference', () => {
  beforeEach(() => {
    setCookie.mockClear()
  })

  test('defaults to the system/browser format and accepts a browser locale seed', () => {
    expect(resolveRegionalFormat(undefined)).toBe('system')
    expect(regionalLocaleFor('system', 'de-DE')).toBe('de-DE')
    expect(resolveServerRegionalLocale('de-DE,de;q=0.9')).toBe('de-DE')
  })

  test('uses explicit German and English regional formats independently of interface language', () => {
    expect(regionalFormats).toEqual(['system', 'de-DE', 'en-US'])
    expect(regionalLocaleFor('de-DE', 'en-US')).toBe('de-DE')
    expect(regionalLocaleFor('en-US', 'de-DE')).toBe('en-US')
  })

  test('falls back safely when browser or Accept-Language values are missing or invalid', () => {
    expect(resolveServerRegionalLocale(undefined)).toBe('en-US')
    expect(resolveServerRegionalLocale('not a locale')).toBe('en-US')

    vi.stubGlobal('navigator', { languages: ['not a locale'], language: 'also not a locale' })
    expect(resolveBrowserRegionalLocale()).toBe('en-US')
    vi.unstubAllGlobals()
  })

  test('persists a supported preference in its independent cookie', async () => {
    await setRegionalFormat('de-DE')

    expect(setCookie).toHaveBeenCalledWith(regionalFormatCookieName, 'de-DE', {
      httpOnly: true,
      maxAge: 60 * 60 * 24 * 365,
      sameSite: 'lax',
      path: '/',
    })
    await expect(setRegionalFormat('fr-FR')).rejects.toThrow('Unsupported regional format: fr-FR')
  })
})
