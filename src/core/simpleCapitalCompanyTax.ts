/** Versioned, deliberately narrow KSt/SolZ/GewSt preview for German UG/GmbH. */
export const CAPITAL_COMPANY_RULES = Object.freeze({
  2025: Object.freeze({ year: 2025 as const, adjustmentVersions: Object.freeze({ income: 'KStG-2025.1', trade: 'GewStG-2025.1' }), corporationTaxNumerator: 15, corporationTaxDenominator: 100, solidarityNumerator: 55, solidarityDenominator: 1000, tradeMeasureNumerator: 35, tradeMeasureDenominator: 1000 }),
  2026: Object.freeze({ year: 2026 as const, adjustmentVersions: Object.freeze({ income: 'KStG-2026.1', trade: 'GewStG-2026.1' }), corporationTaxNumerator: 15, corporationTaxDenominator: 100, solidarityNumerator: 55, solidarityDenominator: 1000, tradeMeasureNumerator: 35, tradeMeasureDenominator: 1000 }),
})

export type CapitalCompanyYear = keyof typeof CAPITAL_COMPANY_RULES
export type CapitalCompanyLegalForm = 'UG' | 'GMBH'
export type CapitalCompanyFacts = Readonly<{ legalForm: CapitalCompanyLegalForm; year: CapitalCompanyYear; establishments: 1; municipalityCode: string; hebesatzBasisPoints: number; foreignIncome: false; groupOrConsolidation: false; lossCarry: false; specialRegime: false; withholdingOrCredits: false; payroll: false }>
export type CapitalCompanyPreview = Readonly<{ ruleVersion: string; taxableIncomeCents: number; corporationTaxCents: number; solidaritySurchargeCents: number; tradeIncomeCents: number; tradeTaxBaseCents: number; tradeTaxCents: number }>

export function capitalCompanyRuleVersion(facts: Pick<CapitalCompanyFacts, 'legalForm' | 'year'>) {
  return facts.legalForm === 'UG' && facts.year === 2025 ? 'DE-UG-SIMPLE-2025.1' : `DE-CAPITAL-COMPANY-${facts.year}.1`
}

function safe(value: number, label: string) { if (!Number.isSafeInteger(value)) throw new Error(`${label} must be safe integer cents.`) }
function floorProduct(value: number, numerator: number, denominator: number) { const result = Number(BigInt(value) * BigInt(numerator) / BigInt(denominator)); safe(result, 'Tax result'); return result }

export function calculateCapitalCompanyTax(hgbResultCents: number, incomeTaxAdjustmentsCents: number, tradeTaxAdjustmentsCents: number, facts: CapitalCompanyFacts): CapitalCompanyPreview {
  safe(hgbResultCents, 'HGB result'); safe(incomeTaxAdjustmentsCents, 'Income-tax adjustments'); safe(tradeTaxAdjustmentsCents, 'Trade-tax adjustments')
  const rules = CAPITAL_COMPANY_RULES[facts.year]
  if (!rules || !['UG', 'GMBH'].includes(facts.legalForm) || facts.establishments !== 1 || !/^\d{8}$/.test(facts.municipalityCode) || !Number.isSafeInteger(facts.hebesatzBasisPoints) || facts.hebesatzBasisPoints < 20000) throw new Error('The local calculation supports only a 2025/2026 single-municipality German UG or GmbH with a canonical municipality and Hebesatz of at least 200%.')
  if (facts.foreignIncome || facts.groupOrConsolidation || facts.lossCarry || facts.specialRegime || facts.withholdingOrCredits || facts.payroll) throw new Error('The local capital-company calculation profile does not support the declared tax fact.')
  const taxableIncomeCents = hgbResultCents + incomeTaxAdjustmentsCents; safe(taxableIncomeCents, 'Taxable income')
  const corporationTaxCents = floorProduct(Math.max(0, taxableIncomeCents), rules.corporationTaxNumerator, rules.corporationTaxDenominator)
  const solidaritySurchargeCents = floorProduct(corporationTaxCents, rules.solidarityNumerator, rules.solidarityDenominator)
  const tradeIncomeCents = taxableIncomeCents + tradeTaxAdjustmentsCents; safe(tradeIncomeCents, 'Trade income')
  const roundedTradeIncomeCents = Math.max(0, Math.floor(tradeIncomeCents / 10000) * 10000)
  const tradeTaxBaseCents = floorProduct(roundedTradeIncomeCents, rules.tradeMeasureNumerator, rules.tradeMeasureDenominator)
  const tradeTaxCents = floorProduct(tradeTaxBaseCents, facts.hebesatzBasisPoints, 10000)
  return Object.freeze({ ruleVersion: capitalCompanyRuleVersion(facts), taxableIncomeCents, corporationTaxCents, solidaritySurchargeCents, tradeIncomeCents, tradeTaxBaseCents, tradeTaxCents })
}
