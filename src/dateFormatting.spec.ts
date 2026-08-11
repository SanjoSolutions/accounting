import { describe, expect, test, vi } from 'vitest'
import { formatDisplayDate } from './dateFormatting'

describe('display date formatting', () => {
  test('delegates date-only values to the browser formatter without changing their calendar day', () => {
    const formatter = vi.fn((date: Date) => `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`)

    expect(formatDisplayDate('2026-08-09', formatter)).toBe('2026-8-9')
    expect(formatter).toHaveBeenCalledWith(expect.any(Date))
    const date = formatter.mock.calls[0][0]
    expect(date).toBeInstanceOf(Date)
    expect(date.getFullYear()).toBe(2026)
    expect(date.getMonth()).toBe(7)
    expect(date.getDate()).toBe(9)
  })

  test('uses the browser default locale instead of an interface locale', () => {
    const calls: Array<[unknown, unknown]> = []
    const originalIntl = globalThis.Intl

    vi.stubGlobal('Intl', {
      ...originalIntl,
      DateTimeFormat: class {
        constructor(locale: unknown, options: unknown) {
          calls.push([locale, options])
        }

        format() {
          return '09.08.2026'
        }
      },
    })

    try {
      expect(formatDisplayDate('2026-08-09')).toBe('09.08.2026')
      expect(calls).toEqual([[undefined, { dateStyle: 'medium' }]])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('returns an invalid API value unchanged', () => {
    const formatter = vi.fn(() => 'formatted')

    expect(formatDisplayDate('not-a-date', formatter)).toBe('not-a-date')
    expect(formatter).not.toHaveBeenCalled()
  })
})
