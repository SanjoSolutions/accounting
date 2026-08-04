import { readFileSync } from 'node:fs'
import { test } from '@playwright/test'
import { DocumentExtractionPage } from './document-extraction-page'
import { buildHybridInvoicePdf } from './hybrid-invoice-fixture'

const cii = readFileSync(new URL('../src/core/data_fixtures/eInvoice/valid-cii.xml', import.meta.url))
const cases = [
  { label: 'CII XML', file: { name: 'supplier-cii.xml', mimeType: 'application/xml', buffer: cii } },
  { label: 'ZUGFeRD hybrid PDF', file: { name: 'supplier-zugferd.pdf', mimeType: 'application/pdf', buffer: buildHybridInvoicePdf(cii) } },
]

test.describe('real CII and hybrid structured incoming payable journeys', () => {
  for (const scenario of cases) test(`Given a ${scenario.label} supplier invoice, when uploaded, reviewed and posted, then its payable, journal, evidence and VAT survive reload`, async ({ page }) => {
    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const invoice = new DocumentExtractionPage(page)
    await invoice.signUp(`${scenario.label} payable ${unique}`, `${scenario.label.replace(/\W/g, '').toLowerCase()}-${unique}@example.test`, 'playwright-password-2026')
    await invoice.uploadReviewAndPostStructured(scenario.file, 'CII-2026-1', '100.00', '19.00')
    await invoice.proveStructuredPayableAfterReload({ invoiceNumber: 'CII-2026-1', supplier: 'Lieferant GmbH', gross: '119.00', fileName: scenario.file.name, inputVatAccount: '1576', inputVat: 'Soll 19,00', vatRule: 'DE_STANDARD' })
  })
})
