import { readFileSync } from 'node:fs'
import { test } from '@playwright/test'
import { DocumentSearchPage } from './document-search-page'
import { scannedSearchPdf } from '../src/test/documentSearchFixtures'

test('Given an uploaded PDF, when searching its name and contents, then matches survive reload and filtering keeps the selection', async ({ page }) => {
  const search = new DocumentSearchPage(page)
  await search.open()
  await search.upload('alpha-Büro.pdf', readFileSync('e2e/fixtures/invoice.pdf'), 'E2E-2026-001')
  await search.proveSearchAndSelection()
  await search.screenshot('text-results')
})

test('Given a scanned PDF, when local OCR indexes it, then content-only matches can be found', async ({ page }) => {
  test.skip(!process.env.DOCUMENT_SEARCH_TEST_OCR_COMMAND, 'Configure a local Tesseract executable to exercise real OCR.')
  const search = new DocumentSearchPage(page)
  await search.open()
  await search.upload('scan.pdf', scannedSearchPdf(), 'Bergwald')
  await search.search('bergwald 47291', ['scan'])
  await search.screenshot('ocr-results')
})
