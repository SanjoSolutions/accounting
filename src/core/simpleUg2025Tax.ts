/**
 * Narrow, deliberately fail-closed 2025 UG calculation profile. This is not a
 * general German tax engine. Amounts are integer cents and all percentage
 * calculations are rounded down to full cents unless a rule says otherwise.
 */
export const SIMPLE_UG_2025_RULE_VERSION = 'DE-UG-SIMPLE-2025.1'

export type SimpleUg2025Facts = Readonly<{
  legalForm: 'UG'
  year: 2025
  establishments: 1
  municipalityCode: string
  hebesatzBasisPoints: number
  foreignIncome: false
  groupOrConsolidation: false
  lossCarry: false
  specialRegime: false
  withholdingOrCredits: false
  payroll: false
}>

/** A non-binding preparation preview. It is never an assessment or an authority result. */
export type SimpleUg2025Preview = Readonly<{
  ruleVersion: typeof SIMPLE_UG_2025_RULE_VERSION
  taxableIncomeCents: number
  corporationTaxCents: number
  solidaritySurchargeCents: number
  tradeIncomeCents: number
  tradeTaxBaseCents: number
  tradeTaxCents: number
}>

function assertSafe(value: number, label: string) {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be safe integer cents.`)
}
function floorProduct(value: number, numerator: number, denominator: number) {
  const product = BigInt(value) * BigInt(numerator)
  const result = product / BigInt(denominator)
  const number = Number(result)
  if (!Number.isSafeInteger(number)) throw new Error('Tax result exceeds safe integer cents.')
  return number
}

export function calculateSimpleUg2025Tax(hgbResultCents: number, incomeTaxAdjustmentsCents: number, tradeTaxAdjustmentsCents: number, facts: SimpleUg2025Facts): SimpleUg2025Preview {
  assertSafe(hgbResultCents, 'HGB result'); assertSafe(incomeTaxAdjustmentsCents, 'Income-tax adjustments'); assertSafe(tradeTaxAdjustmentsCents, 'Trade-tax adjustments')
  if (facts.legalForm !== 'UG' || facts.year !== 2025 || facts.establishments !== 1 || !/^\d{8}$/.test(facts.municipalityCode) || !Number.isSafeInteger(facts.hebesatzBasisPoints) || facts.hebesatzBasisPoints < 20000) throw new Error('The local calculation supports only a 2025 single-municipality UG with a canonical municipality and Hebesatz of at least 200%.')
  if (facts.foreignIncome || facts.groupOrConsolidation || facts.lossCarry || facts.specialRegime || facts.withholdingOrCredits || facts.payroll) throw new Error('The local 2025 UG calculation profile does not support the declared tax fact.')
  const taxableIncomeCents = hgbResultCents + incomeTaxAdjustmentsCents
  if (!Number.isSafeInteger(taxableIncomeCents)) throw new Error('Taxable income exceeds safe integer cents.')
  // This profile does not model losses/carryforwards: negative bases carry no current liability.
  const positiveIncome = Math.max(0, taxableIncomeCents)
  // KStG §23: 15%; SolzG 1995 §4: 5.5% of the corporation-tax basis.
  const corporationTaxCents = floorProduct(positiveIncome, 15, 100)
  const solidaritySurchargeCents = floorProduct(corporationTaxCents, 55, 1000)
  const tradeIncomeCents = taxableIncomeCents + tradeTaxAdjustmentsCents
  if (!Number.isSafeInteger(tradeIncomeCents)) throw new Error('Trade income exceeds safe integer cents.')
  // GewStG §11: floor to full EUR, then 3.5% Steuermesszahl; municipality applies Hebesatz.
  const roundedTradeIncomeCents = Math.max(0, Math.floor(tradeIncomeCents / 10000) * 10000)
  const tradeTaxBaseCents = floorProduct(roundedTradeIncomeCents, 35, 1000)
  const tradeTaxCents = floorProduct(tradeTaxBaseCents, facts.hebesatzBasisPoints, 10000)
  return Object.freeze({ ruleVersion: SIMPLE_UG_2025_RULE_VERSION, taxableIncomeCents, corporationTaxCents, solidaritySurchargeCents, tradeIncomeCents, tradeTaxBaseCents, tradeTaxCents })
}
