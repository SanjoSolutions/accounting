import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { receiveStructuredInvoice } from './eInvoice'
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
    expect(() => structuredIncomingInvoiceFacts({ ...reverseCharge, seller: { ...reverseCharge.seller, countryCode: 'AT' } }, { reverseChargeRateBasisPoints: 1900 })).toThrow(/German business/)
    expect(() => structuredIncomingInvoiceFacts({ ...reverseCharge, lines: [line, { ...line, taxCategoryCode: 'S', reverseCharge: false, taxRateBasisPoints: 1900, exemptionReason: undefined }] }, { reverseChargeRateBasisPoints: 1900 })).toThrow(/every line/)
    expect(() => structuredIncomingInvoiceFacts({ ...reverseCharge, lines: [{ ...line, exemptionReason: 'Reverse charge' }] }, { reverseChargeRateBasisPoints: 1900 })).toThrow(/§13b UStG/)
  })

  it('Given an EU supplier B2B service with exact AE and Article 196 evidence, when 19% is confirmed, then the distinct KZ 46/47 rule is selected and payable stays net', () => {
    const base = invoice([{ description: 'Cloud service', quantity: 1, unitCode: 'C62', netAmountCents: 20_000, taxRateBasisPoints: 0, taxCategoryCode: 'AE', reverseCharge: true, exemptionReason: 'Reverse charge - Article 196 VAT Directive' }])
    const euService = { ...base, seller: { ...base.seller, countryCode: 'AT', vatId: 'ATU12345678' }, buyer: { ...base.buyer, vatId: 'DE987654321' }, reverseCharge: true, taxAmountCents: 0, grossAmountCents: 20_000 }
    expect(structuredIncomingInvoiceFacts(euService, { reverseChargeRateBasisPoints: 1900, reverseChargeSupplyKind: 'SERVICE' })).toMatchObject({
      extraction: { grossAmountCents: 20_000, taxAmountCents: 0 }, reverseCharge: true,
      vatGroups: [{ ruleId: 'EU_13B_SERVICE_RECIPIENT', invoiceRateBasisPoints: 0, rateBasisPoints: 1900, netAmountCents: 20_000, supplierTaxAmountCents: 0, taxAmountCents: 3_800 }],
    })
    expect(() => structuredIncomingInvoiceFacts(euService, { reverseChargeRateBasisPoints: 1900 })).toThrow(/confirm.*services/i)
  })

  it('Given the same supported facts encoded as CII, when parsed and explicitly classified as a service, then the EU recipient rule is derived from parsed evidence', async () => {
    const original = await readFile(path.join(process.cwd(), 'src/core/data_fixtures/eInvoice/valid-cii.xml'), 'utf8')
    const cii = original
      .replace('<ram:Name>Wartung</ram:Name>', '<ram:Name>Subscription position 1</ram:Name>')
      .replace('<ram:CountryID>DE</ram:CountryID></ram:PostalTradeAddress><ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">DE123456789</ram:ID>', '<ram:CountryID>AT</ram:CountryID></ram:PostalTradeAddress><ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">ATU12345678</ram:ID>')
      .replace('</ram:BuyerTradeParty>', '<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">DE987654321</ram:ID></ram:SpecifiedTaxRegistration></ram:BuyerTradeParty>')
      .replaceAll('<ram:CategoryCode>S</ram:CategoryCode>', '<ram:CategoryCode>AE</ram:CategoryCode>')
      .replaceAll('<ram:RateApplicablePercent>19</ram:RateApplicablePercent>', '<ram:RateApplicablePercent>0</ram:RateApplicablePercent>')
      .replaceAll('<ram:CategoryCode>AE</ram:CategoryCode><ram:RateApplicablePercent>0</ram:RateApplicablePercent>', '<ram:CategoryCode>AE</ram:CategoryCode><ram:RateApplicablePercent>0</ram:RateApplicablePercent><ram:ExemptionReason>Reverse charge under Article 196</ram:ExemptionReason>')
      .replace('<ram:CalculatedAmount>19.00</ram:CalculatedAmount>', '<ram:CalculatedAmount>0.00</ram:CalculatedAmount>')
      .replace('<ram:TaxTotalAmount>19.00</ram:TaxTotalAmount>', '<ram:TaxTotalAmount>0.00</ram:TaxTotalAmount>')
      .replace('<ram:GrandTotalAmount currencyID="EUR">119.00</ram:GrandTotalAmount>', '<ram:GrandTotalAmount currencyID="EUR">100.00</ram:GrandTotalAmount>')
      .replace('<ram:DuePayableAmount currencyID="EUR">119.00</ram:DuePayableAmount>', '<ram:DuePayableAmount currencyID="EUR">100.00</ram:DuePayableAmount>')
    const parsed = receiveStructuredInvoice(Buffer.from(cii)).data
    expect(parsed).toMatchObject({ syntax: 'CII', seller: { countryCode: 'AT', vatId: 'ATU12345678' }, buyer: { countryCode: 'DE', vatId: 'DE987654321' }, reverseCharge: true })
    expect(structuredIncomingInvoiceFacts(parsed, { reverseChargeRateBasisPoints: 1900, reverseChargeSupplyKind: 'SERVICE' }).vatGroups).toMatchObject([{ ruleId: 'EU_13B_SERVICE_RECIPIENT', taxAmountCents: 1_900 }])
  })

  it('Given a category-K goods invoice delivered from another EU member state to Germany, when ordinary 19% business goods are confirmed, then acquisition VAT is assessed while the supplier payable stays net', () => {
    const base = invoice([{ description: 'Office chairs', quantity: 4, unitCode: 'C62', netAmountCents: 20_000, taxRateBasisPoints: 0, taxCategoryCode: 'K', exemptionReason: 'Intra-community supply' }])
    const acquisition = { ...base, deliveryCountryCode: 'DE', seller: { ...base.seller, countryCode: 'NL', vatId: 'NL123456789B01' }, buyer: { ...base.buyer, vatId: 'DE987654321' }, taxAmountCents: 0, grossAmountCents: 20_000 }
    expect(structuredIncomingInvoiceFacts(acquisition, { assessmentRateBasisPoints: 1900, supplyClassification: 'STANDARD_GOODS' })).toMatchObject({
      extraction: { grossAmountCents: 20_000, taxAmountCents: 0 }, reverseCharge: false, recipientAssessedVat: true,
      vatGroups: [{ ruleId: 'EU_ACQUISITION', invoiceRateBasisPoints: 0, rateBasisPoints: 1900, netAmountCents: 20_000, supplierTaxAmountCents: 0, taxAmountCents: 3_800 }],
    })
    expect(() => structuredIncomingInvoiceFacts(acquisition, { assessmentRateBasisPoints: 1900 })).toThrow(/ordinary 19% goods/i)
    expect(structuredIncomingInvoiceReviewExtraction(acquisition)).toMatchObject({ netAmountCents: 20_000, taxAmountCents: 0, grossAmountCents: 20_000 })
  })

  it('Given a genuine CII category-K invoice with German delivery evidence, when parsed and confirmed, then the acquisition rule comes from structured facts rather than description inference', async () => {
    const parsed = receiveStructuredInvoice(await readFile(path.join(process.cwd(), 'src/core/data_fixtures/eInvoice/eu-goods-cii.xml'))).data
    expect(parsed).toMatchObject({ syntax: 'CII', deliveryCountryCode: 'DE', lines: [{ taxCategoryCode: 'K' }] })
    expect(structuredIncomingInvoiceFacts(parsed, { assessmentRateBasisPoints: 1900, supplyClassification: 'STANDARD_GOODS' }).vatGroups).toMatchObject([{ ruleId: 'EU_ACQUISITION', taxAmountCents: 1_900 }])
  })
})
