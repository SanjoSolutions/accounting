import { readFileSync } from 'node:fs'
import { test } from '@playwright/test'
import { DocumentExtractionPage } from './document-extraction-page'

const invoicePdf = readFileSync(new URL('./fixtures/invoice.pdf', import.meta.url))

test.describe('real incoming supplier invoice journey', () => {
  test('Given a retained invoice, when extraction is reviewed and posting is confirmed, then its payable, journal, and evidence survive reloads', async ({ page }) => {
    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const invoice = new DocumentExtractionPage(page)
    await invoice.signUp(`Payable ${unique}`, `payable-${unique}@example.test`, 'playwright-password-2026')
    await invoice.uploadAndExtract(invoicePdf)
    await invoice.confirmAndPostPayable()
    await invoice.provePayableAndJournalAfterReload()
  })
})
