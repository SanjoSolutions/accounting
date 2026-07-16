import { describe, expect, it } from 'vitest'
import { defaultFiscalYear, fiscalYearHref } from './FiscalYearNavigation'

describe('fiscal year navigation', () => {
  it('makes any valid annual-close and E-Bilanz year reachable through a generated route', () => {
    expect(fiscalYearHref('annual-close', 2025)).toBe('/annual-close/2025')
    expect(fiscalYearHref('e-bilanz', 2026)).toBe('/e-bilanz/2026')
  })

  it('rejects malformed fiscal years instead of generating broken navigation targets', () => {
    expect(() => fiscalYearHref('annual-close', 2025.5)).toThrow('Invalid fiscal year')
    expect(() => fiscalYearHref('annual-close', 1899)).toThrow('Invalid fiscal year')
    expect(() => fiscalYearHref('annual-close', 2201)).toThrow('Invalid fiscal year')
    expect(() => fiscalYearHref('e-bilanz', 2027)).toThrow('Invalid fiscal year')
    expect(defaultFiscalYear('e-bilanz', 2027)).toBe(2026)
  })
})
