import { readFileSync } from 'node:fs'
import { test } from '@playwright/test'
import { DocumentExtractionPage } from './document-extraction-page'

const invoicePdf = readFileSync(new URL('./fixtures/invoice.pdf', import.meta.url))

test.describe('real document extraction and review journey', () => {
  test('Given a retained text-layer invoice, when it is extracted and reviewed, then byte-bound facts persist after reload', async ({ page }) => {
    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const extraction = new DocumentExtractionPage(page)
    await extraction.signUp(`Extraction ${unique}`, `extraction-${unique}@example.test`, 'playwright-password-2026')
    await extraction.uploadAndExtract(invoicePdf)
    await extraction.reviewAndProveDurability()
  })
})
