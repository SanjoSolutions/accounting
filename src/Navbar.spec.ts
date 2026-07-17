import { describe, expect, it } from 'vitest'
import { exportImportHref } from './Navbar'

describe('main navigation', () => {
  it('links to the dedicated export/import workspace', () => {
    expect(exportImportHref).toBe('/export-import')
  })
})
