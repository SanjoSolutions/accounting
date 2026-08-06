import { describe, expect, it } from 'vitest'
import { canPostIncomingPayable } from './DocumentExtractionPanel'

const reverseCharge = (configured: boolean) => ({ kind: 'DE_13B_DOMESTIC' as const, supportedAssessmentRatesBasisPoints: [1900] as const, reason: '§ 13b UStG', configured })

describe('incoming payable posting controls', () => {
  it('Given an ordinary reviewed invoice, when an expense account is available, then posting remains available without a VAT self-assessment choice', () => {
    expect(canPostIncomingPayable({ busy: false, expenseAccountCount: 1, recipientAssessedVatTreatment: null, assessmentRate: '' })).toBe(true)
  })

  it('Given a domestic reverse-charge invoice, when accounts or the explicit 19% choice are missing, then posting stays fail-closed', () => {
    expect(canPostIncomingPayable({ busy: false, expenseAccountCount: 1, recipientAssessedVatTreatment: reverseCharge(false), assessmentRate: '1900' })).toBe(false)
    expect(canPostIncomingPayable({ busy: false, expenseAccountCount: 1, recipientAssessedVatTreatment: reverseCharge(true), assessmentRate: '' })).toBe(false)
    expect(canPostIncomingPayable({ busy: false, expenseAccountCount: 1, recipientAssessedVatTreatment: reverseCharge(true), assessmentRate: '700' })).toBe(false)
  })

  it('Given configured domestic reverse-charge controls, when the user explicitly selects 19%, then posting becomes available', () => {
    expect(canPostIncomingPayable({ busy: false, expenseAccountCount: 1, recipientAssessedVatTreatment: reverseCharge(true), assessmentRate: '1900' })).toBe(true)
  })

  it('Given a configured EU-service reverse charge, when 19% is explicitly selected, then the same active-chart controls unlock posting', () => {
    const treatment = { ...reverseCharge(true), kind: 'DE_13B_EU_SERVICE' as const }
    expect(canPostIncomingPayable({ busy: false, expenseAccountCount: 1, recipientAssessedVatTreatment: treatment, assessmentRate: '1900' })).toBe(false)
    expect(canPostIncomingPayable({ busy: false, expenseAccountCount: 1, recipientAssessedVatTreatment: treatment, assessmentRate: '1900', supplyClassification: 'STANDARD_GOODS' })).toBe(false)
    expect(canPostIncomingPayable({ busy: false, expenseAccountCount: 1, recipientAssessedVatTreatment: treatment, assessmentRate: '1900', supplyClassification: 'SERVICE' })).toBe(true)
  })

  it('Given configured acquisition controls, when ordinary fully taxable goods and 19% are explicitly confirmed, then posting becomes available', () => {
    const treatment = { ...reverseCharge(true), kind: 'DE_EU_GOODS_ACQUISITION' as const }
    expect(canPostIncomingPayable({ busy: false, expenseAccountCount: 1, recipientAssessedVatTreatment: treatment, assessmentRate: '1900', supplyClassification: 'SERVICE' })).toBe(false)
    expect(canPostIncomingPayable({ busy: false, expenseAccountCount: 1, recipientAssessedVatTreatment: treatment, assessmentRate: '1900', supplyClassification: 'STANDARD_GOODS' })).toBe(true)
  })
})
