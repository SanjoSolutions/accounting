import { describe, expect, test } from 'vitest'
import { formatUstvaCopyValue, ustvaCopyFieldValue, ustvaCopyPages, ustvaPeriodOptions } from './ustvaCopy'

describe('2026 UStVA ELSTER copy mapping', () => {
  test('Given a quarterly profile, when period choices are built, then all four canonical quarters are offered', () => {
    expect(ustvaPeriodOptions(2026, 'QUARTERLY')).toEqual(['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4'])
  })

  test('Given accounting cents, when ELSTER values are formatted, then bases omit cents and tax amounts retain them', () => {
    expect(formatUstvaCopyValue(12_345, 'whole-euros')).toBe('123')
    expect(formatUstvaCopyValue(-12_345, 'whole-euros')).toBe('-123')
    expect(formatUstvaCopyValue(12_345, 'euros-and-cents')).toBe('123,45')
  })

  test('Given the supported field catalog, when pages are rendered, then official codes retain form order and units', () => {
    expect(ustvaCopyPages.map(page => page.page)).toEqual([1, 2, 3])
    expect(ustvaCopyPages[0].fields.map(field => field.code)).toEqual(['81', '86', '87', '41'])
    expect(ustvaCopyPages[1].fields[0]).toMatchObject({ code: '48', section: 'B' })
    expect(ustvaCopyPages[1].fields.find(field => field.code === '46')?.unit).toBe('whole-euros')
    expect(ustvaCopyPages[1].fields.find(field => field.code === '47')?.unit).toBe('euros-and-cents')
    expect(ustvaCopyFieldValue({ KZ83: -1_901 }, ustvaCopyPages[2].fields.find(field => field.code === '83')!)).toBe('-19,01')
  })
})
