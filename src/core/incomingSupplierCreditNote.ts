import type { StructuredInvoiceData } from './eInvoice'

export type SupplierCreditVatGroup = { rateBasisPoints: 700 | 1900; netAmountCents: number; taxAmountCents: number }

export type SupplierCreditPlan = {
  kind: 'credit-note' | 'cancellation'
  effectiveDate: string
  groups: SupplierCreditVatGroup[]
  netAmountCents: number
  taxAmountCents: number
  grossAmountCents: number
  nettingAmountCents: number
  unappliedCreditCents: number
}

export function planIncomingSupplierCredit(input: {
  credit: StructuredInvoiceData
  original: StructuredInvoiceData
  priorCredits: readonly StructuredInvoiceData[]
  originalRemainingCents: number
  effectiveDate: string
  originalAuthoritativeDates: readonly string[]
}): SupplierCreditPlan {
  const { credit, original } = input
  if (credit.kind !== 'credit-note' && credit.kind !== 'cancellation') throw new TypeError('Only supplier credit notes and cancellations can enter this workflow.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveDate) || new Date(`${input.effectiveDate}T00:00:00.000Z`).toISOString().slice(0, 10) !== input.effectiveDate) throw new TypeError('An explicit real adjustment-effective date is required.')
  if (!input.originalAuthoritativeDates.length || input.originalAuthoritativeDates.some(date => !isIsoDate(date))) throw new TypeError('The original authoritative recognition dates are incomplete.')
  if (input.originalAuthoritativeDates.some(date => input.effectiveDate < date)) throw new TypeError('The adjustment-effective date cannot predate the original service, posting, or VAT tax point.')
  if (credit.currency !== 'EUR' || original.currency !== 'EUR' || credit.seller.countryCode !== 'DE' || credit.buyer.countryCode !== 'DE') throw new TypeError('Only domestic German EUR supplier corrections are supported.')
  if (credit.correctedInvoiceNumber !== original.invoiceNumber || JSON.stringify(credit.seller) !== JSON.stringify(original.seller)) throw new TypeError('The credit note must reference the exact original invoice and immutable supplier.')
  if (credit.reverseCharge || credit.exemptionReason || credit.prepaidAmountCents || credit.payableRoundingAmountCents || (credit.payableAmountCents ?? credit.grossAmountCents) !== credit.grossAmountCents) throw new TypeError('Reverse charge, exemptions, prepayments, rounding, and adjusted payable amounts are unsupported.')
  const originalGroups = groups(original)
  const creditedGroups = new Map<number, number>()
  for (const prior of input.priorCredits) for (const group of groups(prior)) creditedGroups.set(group.rateBasisPoints, (creditedGroups.get(group.rateBasisPoints) ?? 0) + group.netAmountCents)
  const creditGroups = groups(credit)
  for (const group of creditGroups) if ((creditedGroups.get(group.rateBasisPoints) ?? 0) + group.netAmountCents > (originalGroups.find(candidate => candidate.rateBasisPoints === group.rateBasisPoints)?.netAmountCents ?? 0)) throw new TypeError('The supplier correction exceeds the immutable original VAT-rate base.')
  const netAmountCents = creditGroups.reduce((sum, group) => sum + group.netAmountCents, 0)
  const taxAmountCents = creditGroups.reduce((sum, group) => sum + group.taxAmountCents, 0)
  if (netAmountCents !== credit.netAmountCents || taxAmountCents !== credit.taxAmountCents || netAmountCents + taxAmountCents !== credit.grossAmountCents || credit.grossAmountCents <= 0) throw new TypeError('Supplier correction totals do not reconcile to canonical 7% and 19% VAT groups.')
  const priorGross = input.priorCredits.reduce((sum, prior) => sum + prior.grossAmountCents, 0)
  if (priorGross + credit.grossAmountCents > original.grossAmountCents) throw new TypeError('The supplier correction exceeds the immutable original invoice amount.')
  if (credit.kind === 'cancellation' && (input.priorCredits.length || credit.netAmountCents !== original.netAmountCents || credit.taxAmountCents !== original.taxAmountCents || credit.grossAmountCents !== original.grossAmountCents)) throw new TypeError('A cancellation must fully reverse the untouched original invoice.')
  if (!Number.isSafeInteger(input.originalRemainingCents) || input.originalRemainingCents < 0) throw new TypeError('The original payable remainder is invalid.')
  const nettingAmountCents = Math.min(input.originalRemainingCents, credit.grossAmountCents)
  return { kind: credit.kind, effectiveDate: input.effectiveDate, groups: creditGroups, netAmountCents, taxAmountCents, grossAmountCents: credit.grossAmountCents, nettingAmountCents, unappliedCreditCents: credit.grossAmountCents - nettingAmountCents }
}

function groups(data: StructuredInvoiceData): SupplierCreditVatGroup[] {
  const grouped = new Map<number, number>()
  for (const line of data.lines) {
    if (line.taxCategoryCode !== 'S' || ![700, 1900].includes(line.taxRateBasisPoints) || !Number.isSafeInteger(line.netAmountCents) || line.netAmountCents <= 0) throw new TypeError('Supplier correction lines require positive domestic standard 7% or 19% VAT bases.')
    grouped.set(line.taxRateBasisPoints, (grouped.get(line.taxRateBasisPoints) ?? 0) + line.netAmountCents)
  }
  return [...grouped].sort(([left], [right]) => left - right).map(([rateBasisPoints, netAmountCents]) => ({ rateBasisPoints: rateBasisPoints as 700 | 1900, netAmountCents, taxAmountCents: roundVat(netAmountCents, rateBasisPoints) }))
}

function roundVat(netCents: number, rateBasisPoints: number) { return Number((BigInt(netCents) * BigInt(rateBasisPoints) + BigInt(5000)) / BigInt(10000)) }
function isIsoDate(value: string) { return /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value }
