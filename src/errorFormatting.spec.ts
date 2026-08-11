import { describe, expect, test } from 'vitest'
import { localizeErrorDates } from './errorFormatting'

describe('human-facing API error date localization', () => {
  test('localizes standalone calendar dates while leaving identifiers untouched', () => {
    expect(localizeErrorDates('DATEV-Buchung am 2026-08-09 ist ungültig (artifact-2026-08-09).', 'de-DE'))
      .toContain('09.08.2026')
    expect(localizeErrorDates('DATEV-Buchung am 2026-08-09 ist ungültig (artifact-2026-08-09).', 'de-DE'))
      .toContain('artifact-2026-08-09')
  })

  test('localizes standalone instants with the selected date-time locale', () => {
    expect(localizeErrorDates('Observed at 2026-08-09T10:15:00.000Z.', 'de-DE')).not.toContain('2026-08-09T10:15:00.000Z')
  })
})
