import { describe, expect, it } from 'vitest'
import { canPostIncomingPayable } from './DocumentExtractionPanel'

const reverseCharge = (configured: boolean) => ({ kind: 'DE_13B_DOMESTIC' as const, supportedAssessmentRatesBasisPoints: [1900] as const, reason: '§ 13b UStG', configured })

describe('incoming payable posting controls', () => {
  it('Given an ordinary reviewed invoice, when an expense account is available, then posting remains available without a VAT self-assessment choice', () => {
    expect(canPostIncomingPayable({ busy: false, expenseAccountCount: 1, reverseChargeTreatment: null, reverseChargeRate: '' })).toBe(true)
  })

  it('Given a domestic reverse-charge invoice, when accounts or the explicit 19% choice are missing, then posting stays fail-closed', () => {
    expect(canPostIncomingPayable({ busy: false, expenseAccountCount: 1, reverseChargeTreatment: reverseCharge(false), reverseChargeRate: '1900' })).toBe(false)
    expect(canPostIncomingPayable({ busy: false, expenseAccountCount: 1, reverseChargeTreatment: reverseCharge(true), reverseChargeRate: '' })).toBe(false)
    expect(canPostIncomingPayable({ busy: false, expenseAccountCount: 1, reverseChargeTreatment: reverseCharge(true), reverseChargeRate: '700' })).toBe(false)
  })

  it('Given configured domestic reverse-charge controls, when the user explicitly selects 19%, then posting becomes available', () => {
    expect(canPostIncomingPayable({ busy: false, expenseAccountCount: 1, reverseChargeTreatment: reverseCharge(true), reverseChargeRate: '1900' })).toBe(true)
  })
})
