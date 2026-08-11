import { describe, expect, test } from 'vitest'
import { formatCount, formatCurrencyFromCents, formatCurrencyFromUnits, formatNumber, formatPercentBasisPoints, formatPercentFraction, formatPercentUnits, inlineNumberScript } from './numberFormatting'

describe('regional number formatting', () => {
  test('formats grouping and decimals independently of interface language', () => {
    expect(formatNumber(1234567.89, 'de-DE', { minimumFractionDigits: 2 })).toBe('1.234.567,89')
    expect(formatNumber(1234567.89, 'en-US', { minimumFractionDigits: 2 })).toBe('1,234,567.89')
    expect(formatCount(1234567, 'de-DE')).toBe('1.234.567')
    expect(formatCount(1234567, 'en-US')).toBe('1,234,567')
  })

  test('uses the explicit currency source and locale-specific placement', () => {
    expect(formatCurrencyFromCents(123456, 'EUR', 'de-DE')).toBe('1.234,56 €')
    expect(formatCurrencyFromCents(123456, 'EUR', 'en-US')).toBe('€1,234.56')
    expect(formatCurrencyFromUnits(12.5, 'USD', 'en-US')).toBe('$12.50')
  })

  test('keeps percentage semantics explicit for fractions, units, and basis points', () => {
    expect(formatPercentFraction(0.19, 'de-DE')).toBe('19 %')
    expect(formatPercentUnits(19, 'en-US')).toBe('19%')
    expect(formatPercentBasisPoints(1900, 'en-US')).toBe('19%')
    expect(formatPercentUnits(7, 'de-DE')).toBe('7 %')
  })

  test('uses the regional preference in the hydration correction without next-intl locale', () => {
    const script = inlineNumberScript('n', 1234.5, { minimumFractionDigits: 1 }, 'de-DE')
    expect(script).toContain('"de-DE"')
    expect(script).not.toContain('useLocale')
    expect(script).toContain('Intl.NumberFormat')
  })
})
