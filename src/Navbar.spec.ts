import { describe, expect, it } from 'vitest'
import { complianceHref, exportImportHref } from './Navbar'

describe('main navigation', () => {
  it('links to the dedicated export/import workspace', () => {
    expect(exportImportHref).toBe('/export-import')
  })
  it('links to the tenant compliance workspace without replacing export/import', () => {
    expect(complianceHref).toBe('/compliance')
    expect(exportImportHref).toBe('/export-import')
  })
})
