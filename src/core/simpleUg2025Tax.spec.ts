import { describe, expect, it } from 'vitest'
import { calculateSimpleUg2025Tax } from './simpleUg2025Tax'

const facts = { legalForm: 'UG' as const, year: 2025 as const, establishments: 1 as const, municipalityCode: '11000000', hebesatzBasisPoints: 41000, foreignIncome: false as const, groupOrConsolidation: false as const, lossCarry: false as const, specialRegime: false as const, withholdingOrCredits: false as const, payroll: false as const }
describe('simple 2025 UG authority', () => {
  it('derives KSt, SolZ and one-municipality GewSt with statutory rounding', () => {
    expect(calculateSimpleUg2025Tax(100_999, 1, 0, facts)).toMatchObject({ taxableIncomeCents: 101_000, corporationTaxCents: 15_150, solidaritySurchargeCents: 833, tradeIncomeCents: 101_000, tradeTaxBaseCents: 3_500, tradeTaxCents: 14_350 })
  })
  it('fails closed outside the documented profile', () => {
    expect(() => calculateSimpleUg2025Tax(1, 0, 0, { ...facts, establishments: 2 } as unknown as typeof facts)).toThrow(/single-municipality/)
    expect(() => calculateSimpleUg2025Tax(1, 0, 0, { ...facts, foreignIncome: true } as unknown as typeof facts)).toThrow(/does not support/)
  })
})
