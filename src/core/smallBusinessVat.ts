import type { EInvoiceLine } from './eInvoice'
import { VatValidationError, type VatRule, type VatSourceSplit } from './vatEngine'

export const SMALL_BUSINESS_RULE = 'DE_SMALL_BUSINESS'
export const SMALL_BUSINESS_NOTICE = 'Steuerbefreiung für Kleinunternehmer gemäß § 19 UStG.'
export const SMALL_BUSINESS_VALID_FROM = '2025-01-01'
export const SMALL_BUSINESS_LIMITS = { previousYearCents: 2_500_000, currentYearCents: 10_000_000, firstYearCents: 2_500_000 } as const
export type CompanyVatRegime = 'STANDARD' | 'SMALL_BUSINESS' | 'EXEMPT'
const purchaseRules = new Set(['DE_STANDARD', 'DE_REDUCED', 'DE_ZERO', 'DE_EXEMPT', 'DE_13B', 'EU_13B_SERVICE_RECIPIENT', 'EU_ACQUISITION', 'IMPORT_VAT'])
const purchaseSuffix = '_NO_INPUT_VAT'

/** Separate immutable rules preserve supplier VAT and recipient tax without a deduction. */
export function smallBusinessVatRules(rules: readonly VatRule[]): VatRule[] {
  return [
    { id: SMALL_BUSINESS_RULE, version: 1, validFrom: SMALL_BUSINESS_VALID_FROM, jurisdiction: 'DE', case: 'exempt', rateBasisPoints: 0, deductibleShareBasisPoints: 0, outputAccount: '8192', returnBoxes: [], reason: SMALL_BUSINESS_NOTICE },
    ...rules.filter(rule => purchaseRules.has(rule.id)).map(rule => ({ ...rule, id: rule.id + purchaseSuffix, validFrom: SMALL_BUSINESS_VALID_FROM, deductibleShareBasisPoints: 0, inputAccount: undefined, returnBoxes: rule.returnBoxes.filter(box => box.value !== 'input-tax' && box.direction !== 'sale'), reason: `${rule.reason}; kein Vorsteuerabzug nach § 15 Abs. 2 UStG (Kleinunternehmer)` })),
  ]
}

export function purchaseVatRule(ruleId: string, regime: CompanyVatRegime): string {
  if (regime !== 'SMALL_BUSINESS') return ruleId
  if (!purchaseRules.has(ruleId)) throw new VatValidationError(['This purchase VAT treatment is not supported for Kleinunternehmer.'])
  return ruleId + purchaseSuffix
}

export function assertVatRegimeRule(regime: CompanyVatRegime, split: VatSourceSplit): void {
  if (split.reversalOf) return // A reversal retains the immutable original treatment.
  const smallRule = split.ruleId === SMALL_BUSINESS_RULE || split.ruleId.endsWith(purchaseSuffix)
  if (regime === 'SMALL_BUSINESS') {
    if (split.taxPoint < SMALL_BUSINESS_VALID_FROM) throw new VatValidationError(['Kleinunternehmer posting is supported from 2025; earlier periods require separate historical treatment.'])
    const allowed = (split.direction ?? 'sale') === 'sale' ? split.ruleId === SMALL_BUSINESS_RULE : [...purchaseRules].some(rule => split.ruleId === rule + purchaseSuffix)
    if (!allowed) throw new VatValidationError(['The effective Kleinunternehmer profile requires §19 exempt domestic sales and purchases without input VAT deduction.'])
  } else if (smallRule) throw new VatValidationError(['An effective Kleinunternehmer company profile is required for this VAT rule.'])
}

export function isSmallBusinessInvoice(lines: readonly EInvoiceLine[], exemptionReason?: string): boolean {
  return lines.length > 0 && lines.every(line => line.taxCategoryCode === 'E' && line.taxRateBasisPoints === 0 && (line.exemptionReason ?? exemptionReason) === SMALL_BUSINESS_NOTICE && !line.reverseCharge)
}

export function domesticSalesRule(rateBasisPoints: number): string {
  return rateBasisPoints === 0 ? SMALL_BUSINESS_RULE : rateBasisPoints === 700 ? 'DE_REDUCED' : 'DE_STANDARD'
}

export function domesticSalesAccounts(chart: string, rateBasisPoints: number, scale = 1) {
  const reduced = rateBasisPoints === 700
  return {
    revenue: (rateBasisPoints === 0 ? chart === 'SKR04' ? 4184 : 8192 : chart === 'SKR04' ? reduced ? 4300 : 4400 : reduced ? 8300 : 8400) * scale,
    outputVat: rateBasisPoints === 0 ? undefined : (chart === 'SKR04' ? reduced ? 3801 : 3806 : reduced ? 1771 : 1776) * scale,
  }
}
