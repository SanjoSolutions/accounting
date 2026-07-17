import { describe, expect, it } from 'vitest'
import { detectSelectedImportFormat, resetDatevForm, selectAccountingFiles, selectDatevFiles } from './ExportImportWorkspace'

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

  it('keeps supported folder files and detects DATEV or Lexware automatically', () => {
    const lexware = [
      { name: 'index.xml' }, { name: 'jour_bp2024.txt' }, { name: 'KTPL_BP2024.txt' },
      { name: 'invoice.PDF' }, { name: 'ignored.exe' },
    ] as File[]
    expect(selectAccountingFiles(lexware).map(file => file.name)).toEqual(['index.xml', 'jour_bp2024.txt', 'KTPL_BP2024.txt', 'invoice.PDF'])
    expect(detectSelectedImportFormat(lexware)).toBe('LEXWARE_BP')
    expect(detectSelectedImportFormat([{ name: 'EXTF_Buchungsstapel.csv' }])).toBe('DATEV')
    expect(detectSelectedImportFormat([...lexware, { name: 'bookings.csv' }])).toBe('UNKNOWN')
    expect(selectAccountingFiles([
      { name: 'EXTF_Buchungsstapel.csv' }, { name: 'large-attachment.pdf' }, { name: 'readme.txt' },
    ] as File[]).map(file => file.name)).toEqual(['EXTF_Buchungsstapel.csv'])
  })
})
