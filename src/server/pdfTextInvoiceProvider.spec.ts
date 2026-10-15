import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { LocalPdfTextInvoiceProvider, parseInvoiceText } from './pdfTextInvoiceProvider'

describe('local PDF text invoice provider', () => {
  test('Given the real text-layer invoice PDF, when it is extracted, then its invoice facts come from preserved bytes', async () => {
    const result = await new LocalPdfTextInvoiceProvider().extract({ content: readFileSync('e2e/fixtures/invoice.pdf'), fileName: 'invoice.pdf', signal: new AbortController().signal })
    expect(result.data).toMatchObject({ supplierName: 'Example Supplier GmbH', invoiceNumber: 'E2E-2026-001', issueDate: '2026-07-23', netAmountCents: 10000, taxAmountCents: 1900, grossAmountCents: 11900, provenance: 'PDF_TEXT' })
    expect(result.rawTextHash).toMatch(/^[a-f0-9]{64}$/)
  })

  test('Given text whose totals contradict, when it is parsed, then no accounting facts are invented', () => {
    expect(parseInvoiceText('Invoice no. X Date: 4 August 2026 Supplier GmbH Net 100.00 EUR VAT 19.00 EUR Gross 118.00 EUR')).toBeNull()
  })

  test('Given a valid PDF without a text layer, when local extraction runs, then it truthfully requires OCR', async () => {
    const blankPdf = Buffer.from(`%PDF-1.4
1 0 obj <</Type/Catalog/Pages 2 0 R>> endobj
2 0 obj <</Type/Pages/Kids[3 0 R]/Count 1>> endobj
3 0 obj <</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>> endobj
trailer <</Root 1 0 R>>
%%EOF`)
    await expect(new LocalPdfTextInvoiceProvider().extract({ content: blankPdf, fileName: 'scan.pdf', signal: new AbortController().signal })).resolves.toEqual({ data: null, rawTextHash: null, failureCode: 'NEEDS_OCR' })
  })
})

describe('whole PDF invoice amounts', () => {
  test.each([
    ['four-digit English amounts', '1000.00', '190.00', '1190.00', 100_000, 19_000, 119_000],
    ['four-digit German amounts', '1000,00', '190,00', '1190,00', 100_000, 19_000, 119_000],
    ['five-digit English amounts', '12345.67', '2345.68', '14691.35', 1_234_567, 234_568, 1_469_135],
    ['five-digit German amounts', '12345,67', '2345,68', '14691,35', 1_234_567, 234_568, 1_469_135],
    ['ungrouped millions', '1000000.00', '190000.00', '1190000.00', 100_000_000, 19_000_000, 119_000_000],
    ['English thousands grouping', '1,000.00', '190.00', '1,190.00', 100_000, 19_000, 119_000],
    ['German thousands grouping', '1.000,00', '190,00', '1.190,00', 100_000, 19_000, 119_000],
    ['English millions grouping', '1,000,000.00', '190,000.00', '1,190,000.00', 100_000_000, 19_000_000, 119_000_000],
    ['German millions grouping', '1.000.000,00', '190.000,00', '1.190.000,00', 100_000_000, 19_000_000, 119_000_000],
    ['English leading zeros', '0001000.00', '00190.00', '0001190.00', 100_000, 19_000, 119_000],
    ['German leading zeros', '0001000,00', '00190,00', '0001190,00', 100_000, 19_000, 119_000],
    ['grouped leading zeros', '001,000.00', '000,190.00', '001,190.00', 100_000, 19_000, 119_000],
    ['zero amounts', '0000.00', '00.00', '0.00', 0, 0, 0],
    ['the largest safe cent total', '90071992547409.90', '0.01', '90071992547409.91', 9_007_199_254_740_990, 1, Number.MAX_SAFE_INTEGER],
  ] as const)('Given %s, when invoice text is parsed, then every digit is preserved', (_description, net, tax, gross, netAmountCents, taxAmountCents, grossAmountCents) => {
    expect(parseInvoiceText(invoiceText(net, tax, gross))).toMatchObject({
      netAmountCents, taxAmountCents, grossAmountCents, provenance: 'PDF_TEXT',
    })
  })

  test('Given the issue #47 arithmetic false positive, when it is parsed, then the full invoice totals are returned', () => {
    expect(parseInvoiceText('Acme GmbH Invoice number: REVIEW-1 Date: 2026-08-01\nNet 1000.00 EUR VAT 190.00 EUR Total 1190.00 EUR')).toMatchObject({
      netAmountCents: 100_000, taxAmountCents: 19_000, grossAmountCents: 119_000,
    })
  })

  test.each([
    '1,00.00', '1.00,00', '1000,000.00', '1000.000,00', '1,000,00', '1.000.00',
    '1.000,000.00', '1,000.000,00', '1,,000.00', '1..000,00', ',1000.00', '.1000,00',
    '1 000.00', '1\u00a0000,00', '1\u202f000,00', '1\n000.00', "1'000.00", '1’000,00',
    '-1000.00', '- 1000.00', '−1000.00', '− 1000.00', '+1000.00', '+ 1000.00', '(1000.00)', '( 1000.00',
    '1000', '1000.0', '1000.000', '1000,000', '1000.00.00', '1e3.00', 'ABC1000.00',
    '1000.00x', '1/1000.00', '1/ 1000.00', '1:1000.00', '1: 1000.00', "1' 000.00", '1’ 000,00', '90071992547409.92',
  ])('Given malformed or unsupported amount %s, when its suffix could balance, then extraction fails', amount => {
    // Equal net and gross plus zero tax would conceal the same corruption in both.
    expect(parseInvoiceText(invoiceText(amount, '0.00', amount))).toBeNull()
  })

  test.each(['net', 'tax', 'gross'])('Given a malformed %s amount before another balanced triple, when parsed, then amounts are not silently skipped', field => {
    const amounts = { net: '1000.00', tax: '190.00', gross: '1190.00', [field]: '1,00.00' }
    expect(parseInvoiceText(`${invoiceText(amounts.net, amounts.tax, amounts.gross)} Other 1000.00 EUR 190.00 EUR 1190.00 EUR`)).toBeNull()
  })

  test('Given additional monetary candidates, when parsed, then ambiguous totals require manual entry', () => {
    expect(parseInvoiceText(`${invoiceText('1000.00', '190.00', '1190.00')} Other 10.00 EUR`)).toBeNull()
  })

  test('Given joined PDF columns and a repeated amount due, when parsed, then the complete net, tax and gross are retained', () => {
    expect(parseInvoiceText('Acme GmbH Invoice number: REVIEW-1 Date: 2026-08-01 Net VAT Gross 1000.00 EUR190.00 EUR1190.00 EUR Amount due 1190.00 EUR')).toMatchObject({
      netAmountCents: 100_000, taxAmountCents: 19_000, grossAmountCents: 119_000,
    })
  })

  test('Given a gross total outside safe integer cents, when individually safe net and tax are added, then extraction fails', () => {
    expect(parseInvoiceText(invoiceText('90071992547409.90', '0.02', '90071992547409.92'))).toBeNull()
  })

  test('Given colon-delimited labels and adjacent currency markers, when parsed, then complete amounts are retained', () => {
    expect(parseInvoiceText('Acme GmbH Invoice number: REVIEW-1 Date: 2026-08-01 Net:1000.00EUR VAT:190.00eur Total:1190.00EUR')).toMatchObject({
      netAmountCents: 100_000, taxAmountCents: 19_000, grossAmountCents: 119_000,
    })
  })

  test('Given a longer word starting with EUR, when parsed, then it is not treated as a currency marker', () => {
    expect(parseInvoiceText(invoiceText('1000.00', '190.00', '1190.00').replaceAll('EUR', 'EURO'))).toBeNull()
  })
})

function invoiceText(net: string, tax: string, gross: string) {
  return `Acme GmbH Invoice number: REVIEW-1 Date: 2026-08-01 Net ${net} EUR VAT ${tax} EUR Total ${gross} EUR`
}
