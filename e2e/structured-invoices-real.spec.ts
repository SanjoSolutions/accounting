import { randomUUID } from 'node:crypto'
import { test } from '@playwright/test'
import { StructuredInvoicesPage } from './structured-invoices-page'

test.describe('real structured UBL outgoing-invoice journey', () => {
  test('Given authoritative UG master data, when an invoice is issued through the UI, then numbering, XML, preview and reload are durable', async ({ page }) => {
    const unique = randomUUID().slice(0, 8)
    const invoices = new StructuredInvoicesPage(page)
    await invoices.signUp(`Invoice ${unique}`, `invoice-${unique}@example.test`, 'playwright-password-2026')
    await invoices.configureIssuerAndCompany()
    await invoices.initializeNumbering(2026)
    await invoices.issueStandardInvoice(2026)
    await invoices.provePreviewDownloadAndReload(2026)
    await invoices.issuePartialCreditAndProveAccounting(2026)
  })
})
