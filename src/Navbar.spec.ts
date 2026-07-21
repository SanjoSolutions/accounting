import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { accountingRouteViews } from './accountingRoutes'
import { accountingNavigation, bookingHref, complianceHref, exportImportHref, journalHref } from './Navbar'

describe('main navigation', () => {
  it('places the journal on a dedicated route alongside booking', () => {
    expect(bookingHref).toBe('/bookings')
    expect(journalHref).toBe('/journal')
    expect(accountingNavigation.map(item => item.href)).toEqual(['/bookings', '/journal'])
  })
  it('uses the home page for metrics and keeps booking and journal content separate', () => {
    expect(accountingRouteViews).toEqual({ '/': 'dashboard', '/bookings': 'booking', '/journal': 'journal' })
  })
  it('labels the booking action as Buchen in German and Book in English', () => {
    const messages = (locale: string) => JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8'))
    expect(messages('de').Navbar.Bookings).toBe('Buchen')
    expect(messages('en').Navbar.Bookings).toBe('Book')
  })
  it('links to the dedicated export/import workspace', () => {
    expect(exportImportHref).toBe('/export-import')
  })
  it('links to the tenant compliance workspace without replacing export/import', () => {
    expect(complianceHref).toBe('/compliance')
    expect(exportImportHref).toBe('/export-import')
  })
})
