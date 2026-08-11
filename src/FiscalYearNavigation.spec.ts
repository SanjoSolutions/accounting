import { describe, expect, test } from 'vitest'
import { defaultFiscalYear, fiscalYearContextFromPath, fiscalYearHref } from './FiscalYearNavigation'

describe('fiscal year navigation', () => {
  test('makes any valid annual-close and E-Bilanz year reachable through a generated route', () => {
    expect(fiscalYearHref('annual-close', 2025)).toBe('/annual-close/2025')
    expect(fiscalYearHref('e-bilanz', 2026)).toBe('/e-bilanz/2026')
    expect(fiscalYearHref('reports', 2025)).toBe('/reports/2025')
  })

  test('rejects malformed fiscal years instead of generating broken navigation targets', () => {
    expect(() => fiscalYearHref('annual-close', 2025.5)).toThrow('Invalid fiscal year')
    expect(() => fiscalYearHref('annual-close', 1899)).toThrow('Invalid fiscal year')
    expect(() => fiscalYearHref('annual-close', 2201)).toThrow('Invalid fiscal year')
    expect(() => fiscalYearHref('e-bilanz', 2027)).toThrow('Invalid fiscal year')
    expect(defaultFiscalYear('e-bilanz', 2027)).toBe(2026)
  })

  test('resolves the header selector route for every workspace that exposes a fiscal year', () => {
    expect(fiscalYearContextFromPath('/', '2025')).toEqual({ area: 'dashboard', year: 2025 })
    expect(fiscalYearContextFromPath('/bookings', '2025')).toEqual({ area: 'bookings', year: 2025 })
    expect(fiscalYearContextFromPath('/booking-batches', '2025')).toEqual({ area: 'booking-batches', year: 2025 })
    expect(fiscalYearContextFromPath('/journal', '2025')).toEqual({ area: 'journal', year: 2025 })
    expect(fiscalYearContextFromPath('/annual-close/2025')).toEqual({ area: 'annual-close', year: 2025 })
    expect(fiscalYearContextFromPath('/e-bilanz/2026')).toEqual({ area: 'e-bilanz', year: 2026 })
    expect(fiscalYearContextFromPath('/tax/2026')).toEqual({ area: 'tax', year: 2026 })
    expect(fiscalYearContextFromPath('/reports/2025')).toEqual({ area: 'reports', year: 2025 })
    expect(fiscalYearHref('dashboard', 2025)).toBe('/?year=2025')
    expect(fiscalYearHref('bookings', 2025)).toBe('/bookings?year=2025')
    expect(fiscalYearHref('booking-batches', 2025)).toBe('/booking-batches?year=2025')
    expect(fiscalYearHref('journal', 2025)).toBe('/journal?year=2025')
  })
})
