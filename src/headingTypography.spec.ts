import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const read = (file: string) => readFileSync(resolve(root, file), 'utf8')
const messages = (locale: 'de' | 'en') => JSON.parse(read(`messages/${locale}.json`)) as Record<string, Record<string, unknown>>

describe('site-wide heading copy', () => {
  test('uses a single semantic page heading instead of redundant eyebrow lines', () => {
    const pageSources = [
      'src/AccountingReportsWorkspace.tsx',
      'src/AnnualCloseWorkspace.tsx',
      'src/BookingBatchWorkspace.tsx',
      'src/ComplianceWorkspace.tsx',
      'src/EBalanceWorkspace.tsx',
      'src/ExportImportWorkspace.tsx',
      'src/TaxWorkspace.tsx',
    ]

    for (const file of pageSources) {
      const source = read(file)
      expect(source, file).toContain('<PageHeading ')
      expect(source, file).not.toContain('className="eyebrow"')
    }
  })

  test('removes redundant kicker message keys from both locales', () => {
    const removed = [
      ['Compliance', 'eyebrow'],
      ['Tax', 'eyebrow'],
      ['AccountingReports', 'eyebrow'],
      ['BookingBatches', 'eyebrow'],
      ['BookingBatches', 'editorEyebrow'],
      ['Workspaces', 'newPosting'],
      ['Workspaces', 'selectedDocuments'],
      ['Workspaces', 'dataExchange'],
      ['Workspaces', 'dataExport'],
      ['Workspaces', 'dataImport'],
      ['Workspaces', 'guidedClose'],
      ['Workspaces', 'taxSubmission'],
    ] as const

    for (const locale of ['de', 'en'] as const) {
      const localeMessages = messages(locale)
      for (const [namespace, key] of removed) expect(localeMessages[namespace]).not.toHaveProperty(key)
    }
  })

  test('uses Buchhaltung for German accounting workflow copy', () => {
    const german = JSON.stringify(messages('de'))
    expect(german).toContain('Buchhaltung')
    expect(german).not.toContain('Buchführung')
  })
})
