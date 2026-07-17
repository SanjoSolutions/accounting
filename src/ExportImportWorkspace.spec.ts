import { describe, expect, it } from 'vitest'
import { resetDatevForm, selectDatevFiles } from './ExportImportWorkspace'

describe('export/import workspace', () => {
  it('keeps only CSV files selected from a DATEV export folder', () => {
    const files = [{ name: 'EXTF_Buchungsstapel.csv' }, { name: 'readme.txt' }, { name: 'EXTF_GP_Stamm.CSV' }] as File[]
    expect(selectDatevFiles(files).map(file => file.name)).toEqual(['EXTF_Buchungsstapel.csv', 'EXTF_GP_Stamm.CSV'])
  })

  it('resets native file inputs after a successful import', () => {
    let resets = 0
    resetDatevForm({ reset: () => { resets++ } })
    expect(resets).toBe(1)
  })
})
