import { describe, expect, it } from 'vitest'
import type { StructuredInvoiceData } from './eInvoice'
import { acquisitionVatTaxPoint, classifyIncomingEuGoodsAcquisition, requireIncomingEuGoodsAcquisitionSelection } from './incomingEuAcquisition'

const invoice = (overrides: Partial<StructuredInvoiceData> = {}): StructuredInvoiceData => ({
  syntax: 'UBL', kind: 'invoice', invoiceNumber: 'AT-GOODS-1', issueDate: '2026-08-14', supplyDate: '2026-08-10', deliveryCountryCode: 'DE',
  seller: { name: 'Vienna Office GmbH', street: 'Ring 1', city: 'Wien', postalCode: '1010', countryCode: 'AT', vatId: 'ATU12345678' },
  buyer: { name: 'Buyer GmbH', street: 'B 2', city: 'Berlin', postalCode: '10115', countryCode: 'DE', vatId: 'DE987654321' },
  lines: [{ description: 'Office chairs', quantity: 4, unitCode: 'C62', netAmountCents: 10_000, taxRateBasisPoints: 0, taxCategoryCode: 'K', exemptionReason: 'Intra-community supply' }],
  netAmountCents: 10_000, taxAmountCents: 0, grossAmountCents: 10_000, payableAmountCents: 10_000, currency: 'EUR', ...overrides,
})

describe('incoming intra-EU goods acquisition classification', () => {
  it('Given category K goods delivered from another EU member state to Germany, when classified, then the narrow §1a acquisition profile is selected', () => {
    expect(classifyIncomingEuGoodsAcquisition(invoice())).toMatchObject({ kind: 'DE_EU_GOODS_ACQUISITION', supportedAssessmentRatesBasisPoints: [1900] })
  })

  it('Given a standard acquisition, when the operator has not confirmed ordinary fully deductible goods and 19%, then posting remains fail-closed', () => {
    const treatment = classifyIncomingEuGoodsAcquisition(invoice())
    expect(() => requireIncomingEuGoodsAcquisitionSelection(treatment, { assessmentRateBasisPoints: 1900 })).toThrow(/ordinary 19% goods/i)
    expect(() => requireIncomingEuGoodsAcquisitionSelection(treatment, { assessmentRateBasisPoints: 700, supplyClassification: 'STANDARD_GOODS' })).toThrow(/19%/)
    expect(requireIncomingEuGoodsAcquisitionSelection(treatment, { assessmentRateBasisPoints: 1900, supplyClassification: 'STANDARD_GOODS' })).toBe(treatment)
  })

  it.each([
    ['German supplier', { seller: { ...invoice().seller, countryCode: 'DE', vatId: 'DE123456789' } }],
    ['third-country supplier', { seller: { ...invoice().seller, countryCode: 'CH', vatId: 'CHE123456789' } }],
    ['Northern Ireland supplier', { seller: { ...invoice().seller, countryCode: 'XI', vatId: 'XI123456789' } }],
    ['foreign destination', { deliveryCountryCode: 'FR' }],
    ['missing buyer VAT ID', { buyer: { ...invoice().buyer, vatId: undefined } }],
    ['foreign supplier VAT mismatch', { seller: { ...invoice().seller, vatId: 'DE123456789' } }],
  ])('Given %s, when classification is attempted, then it fails closed', (_label, overrides) => {
    expect(() => classifyIncomingEuGoodsAcquisition(invoice(overrides as Partial<StructuredInvoiceData>))).toThrow()
  })

  it('Given mixed, non-K, foreign-VAT, or pre-acquisition invoice facts, when classified, then no acquisition is inferred from descriptions', () => {
    const valid = invoice()
    expect(() => classifyIncomingEuGoodsAcquisition(invoice({ lines: [...valid.lines, { ...valid.lines[0], taxCategoryCode: 'S', taxRateBasisPoints: 1900, exemptionReason: undefined }] }))).toThrow(/every line/)
    expect(() => classifyIncomingEuGoodsAcquisition(invoice({ lines: [{ ...valid.lines[0], description: 'Consulting', taxCategoryCode: 'AE', reverseCharge: true }], reverseCharge: true }))).toThrow(/every line/)
    expect(() => classifyIncomingEuGoodsAcquisition(invoice({ taxAmountCents: 1_900, grossAmountCents: 11_900, payableAmountCents: 11_900 }))).toThrow(/supplier VAT of zero/)
    expect(() => classifyIncomingEuGoodsAcquisition(invoice({ issueDate: '2026-08-01' }))).toThrow(/before the goods acquisition/)
  })
})

describe('intra-EU acquisition VAT tax point', () => {
  it('Given invoice dates in the acquisition month, following month, or later, when the tax point is derived, then §13(1)6 invoice timing and the statutory cap are applied', () => {
    expect(acquisitionVatTaxPoint('2026-08-10', '2026-08-14')).toBe('2026-08-14')
    expect(acquisitionVatTaxPoint('2026-08-10', '2026-09-05')).toBe('2026-09-05')
    expect(acquisitionVatTaxPoint('2026-08-10', '2026-10-02')).toBe('2026-09-30')
    expect(acquisitionVatTaxPoint('2026-12-20', '2027-02-03')).toBe('2027-01-31')
  })
})
