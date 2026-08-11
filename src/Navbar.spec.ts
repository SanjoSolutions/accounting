import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { accountingRouteViews } from './accountingRoutes'
import { accountingNavigation, bankingHref, bookingBatchesHref, bookingHref, complianceHref, exportImportHref, fixedAssetsHref, invoicesHref, journalHref, otherNavigationItems, primaryNavigation, receivablesHref, reportsHref } from './Navbar'

describe('main navigation', () => {
  test('keeps booking, booking batches, and journal as the primary destinations', () => {
    expect(bookingHref).toBe('/bookings')
    expect(bookingBatchesHref).toBe('/booking-batches')
    expect(journalHref).toBe('/journal')
    expect(primaryNavigation.map(item => item.href)).toEqual(['/bookings', '/booking-batches', '/journal'])
    expect(accountingNavigation).toEqual(primaryNavigation)
  })
  test('groups every other former menu destination under Andere/Other', () => {
    expect(receivablesHref).toBe('/receivables')
    expect(invoicesHref).toBe('/invoices')
    expect(bankingHref).toBe('/banking')
    expect(fixedAssetsHref).toBe('/fixed-assets')
    expect(otherNavigationItems(2026).map(item => item.href)).toEqual([
      '/receivables', '/invoices', '/banking', '/fixed-assets', '/annual-close/2026', '/e-bilanz/2026', '/tax/2026', '/reports/2026', '/export-import', '/compliance', '/settings',
    ])
  })
  test('uses the home page for metrics and keeps booking and journal content separate', () => {
    expect(accountingRouteViews).toEqual({ '/': 'dashboard', '/bookings': 'booking', '/journal': 'journal' })
  })
  test('translates primary labels and the Andere grouping for German and English', () => {
    const messages = (locale: string) => JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8'))
    expect(messages('de').Navbar.Bookings).toBe('Buchen')
    expect(messages('en').Navbar.Bookings).toBe('Book')
    expect(messages('de').Navbar['Booking batches']).toBe('Buchungsstapel')
    expect(messages('en').Navbar['Booking batches']).toBe('Booking batches')
    expect(messages('de').Navbar.Other).toBe('Andere')
    expect(messages('en').Navbar.Other).toBe('Other')
  })
  test('links to the dedicated export/import workspace', () => {
    expect(exportImportHref).toBe('/export-import')
  })
  test('links to the tenant compliance workspace without replacing export/import', () => {
    expect(complianceHref).toBe('/compliance')
    expect(exportImportHref).toBe('/export-import')
  })
  test('links to fiscal-year accounting reports', () => {
    expect(reportsHref).toBe('/reports')
  })
})
