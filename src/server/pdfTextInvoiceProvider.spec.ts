import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LocalPdfTextInvoiceProvider, parseInvoiceText } from './pdfTextInvoiceProvider'

describe('local PDF text invoice provider', () => {
  it('Given the real text-layer invoice PDF, when it is extracted, then its invoice facts come from preserved bytes', async () => {
    const result = await new LocalPdfTextInvoiceProvider().extract({ content: readFileSync('e2e/fixtures/invoice.pdf'), fileName: 'invoice.pdf', signal: new AbortController().signal })
    expect(result.data).toMatchObject({ supplierName: 'Example Supplier GmbH', invoiceNumber: 'E2E-2026-001', issueDate: '2026-07-23', netAmountCents: 10000, taxAmountCents: 1900, grossAmountCents: 11900, provenance: 'PDF_TEXT' })
    expect(result.rawTextHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('Given text whose totals contradict, when it is parsed, then no accounting facts are invented', () => {
    expect(parseInvoiceText('Invoice no. X Date: 4 August 2026 Supplier GmbH Net 100.00 EUR VAT 19.00 EUR Gross 118.00 EUR')).toBeNull()
  })

  it('Given a valid PDF without a text layer, when local extraction runs, then it truthfully requires OCR', async () => {
    const blankPdf = Buffer.from(`%PDF-1.4
1 0 obj <</Type/Catalog/Pages 2 0 R>> endobj
2 0 obj <</Type/Pages/Kids[3 0 R]/Count 1>> endobj
3 0 obj <</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>> endobj
trailer <</Root 1 0 R>>
%%EOF`)
    await expect(new LocalPdfTextInvoiceProvider().extract({ content: blankPdf, fileName: 'scan.pdf', signal: new AbortController().signal })).resolves.toEqual({ data: null, rawTextHash: null, failureCode: 'NEEDS_OCR' })
  })
})
