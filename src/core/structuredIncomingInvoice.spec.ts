import { describe, expect, it } from 'vitest'
import type { StructuredInvoiceData } from './eInvoice'
import { structuredIncomingInvoiceFacts, structuredIncomingInvoiceReviewExtraction } from './structuredIncomingInvoice'

const invoice = (lines: StructuredInvoiceData['lines']): StructuredInvoiceData => ({ syntax: 'UBL', kind: 'invoice', invoiceNumber: 'RE-MIXED', issueDate: '2026-08-01', supplyDate: '2026-08-01', seller: { name: 'Supplier GmbH', street: 'A 1', city: 'Berlin', postalCode: '10115', countryCode: 'DE' }, buyer: { name: 'Buyer GmbH', street: 'B 2', city: 'Berlin', postalCode: '10115', countryCode: 'DE' }, lines, netAmountCents: 20_000, taxAmountCents: 2_600, grossAmountCents: 22_600, currency: 'EUR' })

describe('structured incoming invoice payable facts', () => {
  it('Given consistent mixed 7% and 19% UBL lines, when facts are derived, then separate exact VAT buckets are retained', () => {
    expect(structuredIncomingInvoiceFacts(invoice([
      { description: 'Food', quantity: 1, unitCode: 'C62', netAmountCents: 10_000, taxRateBasisPoints: 700, taxCategoryCode: 'S' },
      { description: 'Service', quantity: 1, unitCode: 'C62', netAmountCents: 10_000, taxRateBasisPoints: 1900, taxCategoryCode: 'S' },
    ]))).toMatchObject({ vatGroups: [{ ruleId: 'DE_REDUCED', netAmountCents: 10_000, taxAmountCents: 700 }, { ruleId: 'DE_STANDARD', netAmountCents: 10_000, taxAmountCents: 1_900 }], extraction: { provenance: 'STRUCTURED_INVOICE' } })
  })

  it('Given inconsistent line VAT or an exemption disguised as zero rate, when facts are derived, then posting fails closed', () => {
    expect(() => structuredIncomingInvoiceFacts({ ...invoice([{ description: 'Wrong', quantity: 1, unitCode: 'C62', netAmountCents: 20_000, taxRateBasisPoints: 700, taxCategoryCode: 'S' }]) })).toThrow(/reconcile/)
    expect(() => structuredIncomingInvoiceFacts({ ...invoice([{ description: 'Exempt', quantity: 1, unitCode: 'C62', netAmountCents: 20_000, taxRateBasisPoints: 0, taxCategoryCode: 'E', exemptionReason: 'UStG' }]), taxAmountCents: 0, grossAmountCents: 20_000 })).toThrow(/exemption/)
  })

  it('Given a domestic category-AE invoice, when 19% §13b is explicitly confirmed, then exact simultaneous output and deductible input VAT facts are derived while payable remains net', () => {
    const reverseCharge = { ...invoice([{ description: 'Domestic construction service', quantity: 1, unitCode: 'C62', netAmountCents: 20_000, taxRateBasisPoints: 0, taxCategoryCode: 'AE', reverseCharge: true, exemptionReason: 'Steuerschuldnerschaft des Leistungsempfängers gemäß § 13b UStG' }]), reverseCharge: true, taxAmountCents: 0, grossAmountCents: 20_000 }
    expect(structuredIncomingInvoiceFacts(reverseCharge, { reverseChargeRateBasisPoints: 1900 })).toMatchObject({
      reverseCharge: true,
      extraction: { netAmountCents: 20_000, taxAmountCents: 0, grossAmountCents: 20_000 },
      vatGroups: [{ ruleId: 'DE_13B', invoiceRateBasisPoints: 0, rateBasisPoints: 1900, netAmountCents: 20_000, supplierTaxAmountCents: 0, taxAmountCents: 3_800 }],
    })
  })

  it('Given a valid domestic category-AE invoice, when it first enters human review, then authoritative supplier totals are retained without prematurely choosing a recipient assessment rate', () => {
    const reverseCharge = { ...invoice([{ description: 'Domestic construction service', quantity: 1, unitCode: 'C62', netAmountCents: 20_000, taxRateBasisPoints: 0, taxCategoryCode: 'AE', reverseCharge: true, exemptionReason: 'Steuerschuldnerschaft des Leistungsempfängers gemäß § 13b UStG' }]), reverseCharge: true, taxAmountCents: 0, grossAmountCents: 20_000 }
    expect(structuredIncomingInvoiceReviewExtraction(reverseCharge)).toMatchObject({ netAmountCents: 20_000, taxAmountCents: 0, grossAmountCents: 20_000, provenance: 'STRUCTURED_INVOICE' })
  })

  it('Given ambiguous, reduced-rate, foreign, or mixed reverse charge, when payable facts are requested, then the product fails closed before accounting', () => {
    const line = { description: 'Service', quantity: 1, unitCode: 'C62', netAmountCents: 20_000, taxRateBasisPoints: 0, taxCategoryCode: 'AE', reverseCharge: true, exemptionReason: '§ 13b UStG' }
    const reverseCharge = { ...invoice([line]), reverseCharge: true, taxAmountCents: 0, grossAmountCents: 20_000 }
    expect(() => structuredIncomingInvoiceFacts(reverseCharge)).toThrow(/Confirm.*19%/)
    expect(() => structuredIncomingInvoiceFacts(reverseCharge, { reverseChargeRateBasisPoints: 700 })).toThrow(/19%/)
    expect(() => structuredIncomingInvoiceFacts({ ...reverseCharge, seller: { ...reverseCharge.seller, countryCode: 'AT' } }, { reverseChargeRateBasisPoints: 1900 })).toThrow(/domestic German/)
    expect(() => structuredIncomingInvoiceFacts({ ...reverseCharge, lines: [line, { ...line, taxCategoryCode: 'S', reverseCharge: false, taxRateBasisPoints: 1900, exemptionReason: undefined }] }, { reverseChargeRateBasisPoints: 1900 })).toThrow(/every line/)
    expect(() => structuredIncomingInvoiceFacts({ ...reverseCharge, lines: [{ ...line, exemptionReason: 'Reverse charge' }] }, { reverseChargeRateBasisPoints: 1900 })).toThrow(/§13b UStG/)
  })
})
