import type { StructuredInvoiceData } from './eInvoice'
import { isOtherEuCountry, matchesOtherEuVatId, normalizeIncomingVatId } from './incomingReverseCharge'

export type IncomingEuGoodsAcquisitionTreatment = {
  kind: 'DE_EU_GOODS_ACQUISITION'
  supportedAssessmentRatesBasisPoints: readonly [1900]
  reason: 'UStG §1a, §3d, §13(1)6, §15(1)3'
}

export function isIncomingEuGoodsAcquisitionCandidate(data: StructuredInvoiceData) {
  return data.lines.some(line => line.taxCategoryCode === 'K')
}

export function classifyIncomingEuGoodsAcquisition(data: StructuredInvoiceData): IncomingEuGoodsAcquisitionTreatment {
  const sellerCountry = data.seller.countryCode.toUpperCase()
  if (!isOtherEuCountry(sellerCountry)) throw new TypeError('Intra-EU goods acquisition supports only a supplier established in another current EU member country, excluding Germany, third countries, Northern Ireland, and special territories.')
  if (data.buyer.countryCode !== 'DE' || !/^DE\d{9}$/.test(normalizeIncomingVatId(data.buyer.vatId))) throw new TypeError('Intra-EU goods acquisition requires a German business buyer with a German VAT ID.')
  if (!matchesOtherEuVatId(sellerCountry, data.seller.vatId)) throw new TypeError('Intra-EU goods acquisition requires a syntactically valid supplier VAT ID matching the other EU member country.')
  if (data.deliveryCountryCode !== 'DE') throw new TypeError('Intra-EU goods acquisition requires structured evidence that transport of the goods ended in Germany.')
  if (!data.supplyDate) throw new TypeError('Intra-EU goods acquisition requires an exact acquisition date.')
  if (data.reverseCharge || !data.lines.length || data.lines.some(line => line.taxCategoryCode !== 'K' || line.reverseCharge || line.taxRateBasisPoints !== 0 || !line.exemptionReason?.trim())) {
    throw new TypeError('Intra-EU goods acquisition requires every line to use EN16931 category K, zero supplier VAT, and an explicit intra-community-supply reason.')
  }
  if (data.taxAmountCents !== 0 || data.grossAmountCents !== data.netAmountCents || (data.payableAmountCents ?? data.grossAmountCents) !== data.netAmountCents) throw new TypeError('An intra-EU goods supplier invoice must have supplier VAT of zero and payable gross equal to net.')
  acquisitionVatTaxPoint(data.supplyDate, data.issueDate)
  return { kind: 'DE_EU_GOODS_ACQUISITION', supportedAssessmentRatesBasisPoints: [1900], reason: 'UStG §1a, §3d, §13(1)6, §15(1)3' }
}

export function requireIncomingEuGoodsAcquisitionSelection(classification: IncomingEuGoodsAcquisitionTreatment, input: { assessmentRateBasisPoints?: number; supplyClassification?: string }) {
  if (input.supplyClassification !== 'STANDARD_GOODS') throw new TypeError('Explicitly confirm ordinary 19% goods acquired wholly for taxable business use before posting.')
  if (input.assessmentRateBasisPoints !== 1900) throw new TypeError('Confirm the supported 19% intra-EU goods acquisition assessment rate explicitly before posting.')
  return classification
}

/** §13(1)6 UStG: invoice date, capped at the end of the month following acquisition. */
export function acquisitionVatTaxPoint(acquisitionDate: string, invoiceIssueDate: string) {
  if (!isRealDate(acquisitionDate) || !isRealDate(invoiceIssueDate)) throw new TypeError('Intra-EU acquisition and invoice dates must be real ISO dates.')
  if (invoiceIssueDate < acquisitionDate) throw new TypeError('An invoice issued before the goods acquisition is unsupported because advance invoices do not trigger acquisition VAT.')
  const acquisition = new Date(`${acquisitionDate}T00:00:00.000Z`)
  const deadline = new Date(Date.UTC(acquisition.getUTCFullYear(), acquisition.getUTCMonth() + 2, 0)).toISOString().slice(0, 10)
  return invoiceIssueDate < deadline ? invoiceIssueDate : deadline
}

function isRealDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value
}
