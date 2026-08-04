import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { generateXRechnungUblInvoice, type StructuredInvoiceData, type XRechnungElectronicAddress } from './eInvoice'
import { assertKositXRechnungAcceptance, assertKositXRechnungRejection } from './kositValidationReport'

const validatorJar = process.env.KOSIT_VALIDATOR_JAR
const scenarios = process.env.KOSIT_XRECHNUNG_SCENARIOS
const configured = Boolean(validatorJar && scenarios)

const variants: Array<{
  name: string
  buyer: { name: string; street: string; postalCode: string; city: string; countryCode: string; vatId?: string }
  buyerReference: string
  buyerElectronicAddress: XRechnungElectronicAddress
  lines: StructuredInvoiceData['lines']
  netAmountCents: number
  taxAmountCents: number
}> = [
  {
    name: 'public-leitweg-id-19-percent',
    buyer: { name: 'Öffentliche Verwaltung', street: 'Kundenweg 2', postalCode: '50667', city: 'Köln', countryCode: 'DE' },
    buyerReference: '04011000-12345-03', buyerElectronicAddress: { schemeId: '0204', value: '04011000-12345-03' },
    lines: [{ description: 'Software consulting', quantity: 1, unitCode: 'C62', netAmountCents: 10_000, taxRateBasisPoints: 1_900, taxCategoryCode: 'S' }],
    netAmountCents: 10_000, taxAmountCents: 1_900,
  },
  {
    name: 'business-vat-id-mixed-rates',
    buyer: { name: 'Musterkunde GmbH', street: 'Kundenweg 2', postalCode: '50667', city: 'Köln', countryCode: 'DE', vatId: 'DE987654321' },
    buyerReference: 'PO-2026-42', buyerElectronicAddress: { schemeId: '9930', value: 'DE987654321' },
    lines: [
      { description: 'Standard service', quantity: 1, unitCode: 'C62', netAmountCents: 10_000, taxRateBasisPoints: 1_900, taxCategoryCode: 'S' },
      { description: 'Reduced-rate publication', quantity: 1, unitCode: 'C62', netAmountCents: 1_000, taxRateBasisPoints: 700, taxCategoryCode: 'S' },
    ],
    netAmountCents: 11_000, taxAmountCents: 1_970,
  },
  {
    name: 'business-email-endpoint',
    buyer: { name: 'Kleine GmbH', street: 'Kundenweg 3', postalCode: '50667', city: 'Köln', countryCode: 'DE', vatId: 'DE987654321' },
    buyerReference: 'ORDER-EMAIL-1', buyerElectronicAddress: { schemeId: 'EM', value: 'rechnung@example.de' },
    lines: [{ description: 'Support service', quantity: 1, unitCode: 'C62', netAmountCents: 5_000, taxRateBasisPoints: 1_900, taxCategoryCode: 'S' }],
    netAmountCents: 5_000, taxAmountCents: 950,
  },
]

function invoiceFor(variant: typeof variants[number], index: number) {
  return generateXRechnungUblInvoice({
    kind: 'invoice', invoiceNumber: `2026-${String(index + 1).padStart(6, '0')}`, issueDate: '2026-08-04', supplyDate: '2026-08-04', currency: 'EUR',
    seller: { name: 'Beispiel UG (haftungsbeschränkt)', street: 'Musterstraße 1', postalCode: '10115', city: 'Berlin', countryCode: 'DE', taxId: '12/345/67890', vatId: 'DE123456789' },
    buyer: variant.buyer, buyerReference: variant.buyerReference, buyerElectronicAddress: variant.buyerElectronicAddress,
    sellerContact: { name: 'Accounts receivable', telephone: '+49 30 123456', email: 'billing@example.de' },
    lines: variant.lines, netAmountCents: variant.netAmountCents, taxAmountCents: variant.taxAmountCents,
    grossAmountCents: variant.netAmountCents + variant.taxAmountCents, paymentTerms: 'Payable within 14 days.', paymentIban: 'DE89370400440532013000',
  })
}

describe('official KoSIT XRechnung contract', () => {
  for (const [index, variant] of variants.entries()) {
    it.skipIf(!configured)(`Given the ${variant.name} profile, when KoSIT XRechnung 3.0.2 validates it, then official XML and HTML acceptance reports are retained`, () => {
      const root = process.env.KOSIT_REPORT_DIR || mkdtempSync(join(tmpdir(), 'xrechnung-contract-'))
      const directory = join(root, variant.name)
      mkdirSync(directory, { recursive: true })
      const invoicePath = join(directory, 'invoice.xml')
      const invoice = invoiceFor(variant, index)
      writeFileSync(invoicePath, invoice)
      const validation = spawnSync('java', ['-jar', validatorJar!, '-s', scenarios!, '-r', dirname(scenarios!), '-o', directory, '-h', invoicePath], { encoding: 'utf8' })
      expect(validation.status, `${validation.stdout}\n${validation.stderr}`).toBe(0)
      const reports = readdirSync(directory).filter(name => /report\.(?:xml|html)$/.test(name))
      expect(reports).toEqual(expect.arrayContaining([expect.stringMatching(/\.xml$/), expect.stringMatching(/\.html$/)]))
      const xmlReports = reports.filter(name => name.endsWith('.xml'))
      expect(xmlReports).toHaveLength(1)
      expect(assertKositXRechnungAcceptance(readFileSync(join(directory, xmlReports[0]), 'utf8'), invoice)).toMatchObject({ reportValid: 'true', accepts: 1, rejects: 0 })
    }, 60_000)
  }

  it.skipIf(!configured)('Given an app-generated invoice with a required business term removed, when KoSIT validates it, then the retained report proves exact rejection semantics', () => {
    const root = process.env.KOSIT_REPORT_DIR || mkdtempSync(join(tmpdir(), 'xrechnung-contract-'))
    const directory = join(root, 'invalid-missing-buyer-reference')
    mkdirSync(directory, { recursive: true })
    const validInvoice = Buffer.from(invoiceFor(variants[0], 99)).toString('utf8')
    const invalidInvoice = validInvoice.replace(/<cbc:BuyerReference>[\s\S]*?<\/cbc:BuyerReference>/, '')
    expect(invalidInvoice).not.toBe(validInvoice)
    const invoicePath = join(directory, 'invoice.xml')
    writeFileSync(invoicePath, invalidInvoice)
    const validation = spawnSync('java', ['-jar', validatorJar!, '-s', scenarios!, '-r', dirname(scenarios!), '-o', directory, '-h', invoicePath], { encoding: 'utf8' })
    expect(validation.error, `${validation.stdout}\n${validation.stderr}`).toBeUndefined()
    const reports = readdirSync(directory).filter(name => /report\.(?:xml|html)$/.test(name))
    expect(reports).toEqual(expect.arrayContaining([expect.stringMatching(/\.xml$/), expect.stringMatching(/\.html$/)]))
    const xmlReports = reports.filter(name => name.endsWith('.xml'))
    expect(xmlReports).toHaveLength(1)
    expect(assertKositXRechnungRejection(readFileSync(join(directory, xmlReports[0]), 'utf8'), invalidInvoice)).toMatchObject({ reportValid: 'false', accepts: 0, rejects: 1 })
  }, 60_000)
})
