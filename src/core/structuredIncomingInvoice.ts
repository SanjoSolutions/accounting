import type { StructuredInvoiceData } from './eInvoice'
import type { InvoiceExtractionData } from './documentExtraction'
import { classifyIncomingGermanReverseCharge, requireIncomingReverseChargeRate } from './incomingReverseCharge'

export type StructuredIncomingVatGroup = { rateBasisPoints: 0 | 700 | 1900; invoiceRateBasisPoints: 0 | 700 | 1900; netAmountCents: number; taxAmountCents: number; supplierTaxAmountCents: number; ruleId: 'DE_ZERO' | 'DE_REDUCED' | 'DE_STANDARD' | 'DE_13B' | 'EU_13B_SERVICE_RECIPIENT' }

export function structuredIncomingInvoiceFacts(data: StructuredInvoiceData, options: { reverseChargeRateBasisPoints?: number; reverseChargeSupplyKind?: 'SERVICE' } = {}): { extraction: InvoiceExtractionData; vatGroups: StructuredIncomingVatGroup[]; reverseCharge: boolean } {
  validateSupportedIncomingInvoice(data)
  const reverseCharge = classifyIncomingGermanReverseCharge(data)
  const reverseChargeRate = requireIncomingReverseChargeRate(reverseCharge, options.reverseChargeRateBasisPoints)
  if (reverseCharge) {
    if (reverseCharge.kind === 'DE_13B_EU_SERVICE' && options.reverseChargeSupplyKind !== 'SERVICE') throw new TypeError('Explicitly confirm that the EU supplier invoice contains B2B services before posting.')
    const netAmountCents = reconciledReverseChargeNet(data)
    const assessedTaxAmountCents = roundVat(netAmountCents, reverseChargeRate!)
    return { extraction: extraction(data), reverseCharge: true, vatGroups: [{ rateBasisPoints: 1900, invoiceRateBasisPoints: 0, netAmountCents, taxAmountCents: assessedTaxAmountCents, supplierTaxAmountCents: 0, ruleId: reverseCharge.kind === 'DE_13B_EU_SERVICE' ? 'EU_13B_SERVICE_RECIPIENT' : 'DE_13B' }] }
  }

  return ordinaryIncomingInvoiceFacts(data)
}

export function structuredIncomingInvoiceReviewExtraction(data: StructuredInvoiceData) {
  validateSupportedIncomingInvoice(data)
  if (classifyIncomingGermanReverseCharge(data)) {
    reconciledReverseChargeNet(data)
    return extraction(data)
  }
  return ordinaryIncomingInvoiceFacts(data).extraction
}

function validateSupportedIncomingInvoice(data: StructuredInvoiceData) {
  if (data.kind !== 'invoice') throw new TypeError('Only structured supplier invoices can enter payable posting; corrections require a dedicated linked workflow.')
  if (data.currency !== 'EUR') throw new TypeError('Only EUR structured supplier invoices can currently be posted.')
  if (data.buyer.countryCode !== 'DE') throw new TypeError('Only structured supplier invoices for a German buyer can currently be posted.')
  if (data.seller.countryCode !== 'DE' && !data.reverseCharge && !data.lines.some(line => line.taxCategoryCode === 'AE' || line.reverseCharge)) throw new TypeError('Foreign ordinary supplier invoices require a dedicated posting workflow.')
  if (data.exemptionReason && !data.reverseCharge || (data.prepaidAmountCents ?? 0) !== 0 || (data.payableRoundingAmountCents ?? 0) !== 0 || (data.payableAmountCents ?? data.grossAmountCents) !== data.grossAmountCents) throw new TypeError('Exemptions, prepayments, rounding, and adjusted payable amounts require a dedicated payable workflow.')
  if (!data.lines.length) throw new TypeError('At least one structured supplier invoice line is required.')
}

function ordinaryIncomingInvoiceFacts(data: StructuredInvoiceData): { extraction: InvoiceExtractionData; vatGroups: StructuredIncomingVatGroup[]; reverseCharge: false } {
  const grouped = new Map<number, number>()
  for (const line of data.lines) {
    if (![0, 700, 1900].includes(line.taxRateBasisPoints)) throw new TypeError('Only domestic 0%, 7%, and 19% input VAT are supported.')
    if (line.reverseCharge || line.exemptionReason) throw new TypeError('Structured supplier invoice lines with reverse charge or exemptions are unsupported.')
    if (line.taxRateBasisPoints === 0 ? line.taxCategoryCode !== 'Z' : line.taxCategoryCode !== 'S') throw new TypeError('Structured line VAT category and rate must identify standard domestic VAT without ambiguity.')
    grouped.set(line.taxRateBasisPoints, (grouped.get(line.taxRateBasisPoints) ?? 0) + line.netAmountCents)
  }
  const vatGroups = [...grouped].sort(([left], [right]) => left - right).map(([rateBasisPoints, netAmountCents]) => ({
    rateBasisPoints: rateBasisPoints as 0 | 700 | 1900,
    invoiceRateBasisPoints: rateBasisPoints as 0 | 700 | 1900,
    netAmountCents,
    taxAmountCents: roundVat(netAmountCents, rateBasisPoints),
    supplierTaxAmountCents: roundVat(netAmountCents, rateBasisPoints),
    ruleId: rateBasisPoints === 0 ? 'DE_ZERO' as const : rateBasisPoints === 700 ? 'DE_REDUCED' as const : 'DE_STANDARD' as const,
  }))
  const netAmountCents = vatGroups.reduce((total, group) => total + group.netAmountCents, 0)
  const taxAmountCents = vatGroups.reduce((total, group) => total + group.taxAmountCents, 0)
  if (netAmountCents !== data.netAmountCents || taxAmountCents !== data.taxAmountCents || netAmountCents + taxAmountCents !== data.grossAmountCents) throw new TypeError('Structured line VAT buckets do not reconcile exactly to the authoritative invoice totals.')
  return { extraction: {
    supplierName: data.seller.name, invoiceNumber: data.invoiceNumber, issueDate: data.issueDate,
    netAmountCents, taxAmountCents, grossAmountCents: data.grossAmountCents, currency: 'EUR',
    confidence: { supplierName: 1, invoiceNumber: 1, issueDate: 1, netAmountCents: 1, taxAmountCents: 1, grossAmountCents: 1 }, provenance: 'STRUCTURED_INVOICE',
  }, vatGroups, reverseCharge: false }
}

function reconciledReverseChargeNet(data: StructuredInvoiceData) {
  const netAmountCents = data.lines.reduce((total, line) => total + line.netAmountCents, 0)
  if (netAmountCents !== data.netAmountCents) throw new TypeError('Structured §13b line amounts do not reconcile exactly to the authoritative invoice total.')
  return netAmountCents
}

function extraction(data: StructuredInvoiceData): InvoiceExtractionData { return { supplierName: data.seller.name, invoiceNumber: data.invoiceNumber, issueDate: data.issueDate, netAmountCents: data.netAmountCents, taxAmountCents: data.taxAmountCents, grossAmountCents: data.grossAmountCents, currency: 'EUR', confidence: { supplierName: 1, invoiceNumber: 1, issueDate: 1, netAmountCents: 1, taxAmountCents: 1, grossAmountCents: 1 }, provenance: 'STRUCTURED_INVOICE' } }

function roundVat(netCents: number, rateBasisPoints: number) { return Number((BigInt(netCents) * BigInt(rateBasisPoints) + BigInt(5000)) / BigInt(10000)) }
