import { describe, expect, it } from 'vitest'
import { HGB_KIND_SCHEDULE_TYPE, assertHgbReview, normalizeHgbAdjustment, validateHgbWorkpaper, type HgbWorkpaperDraft } from './hgbWorkpapers'
import { HGB_WORKPAPER_KINDS } from './hgbClose'

const period = { startsAt: '2026-01-01', endsAt: '2026-12-31' }
const adjustment = {
  id: 'adj-1', bookingDate: '2026-12-31', description: 'Accrued audit fee', evidenceIds: ['calc-1'],
  lines: [{ accountId: 'expense', debitCents: 10_000, creditCents: 0 }, { accountId: 'liability', debitCents: 0, creditCents: 10_000 }],
}
const cutoff = (): HgbWorkpaperDraft => ({
  kind: 'CUT_OFF_AND_ACCRUAL_DEFERRAL', title: 'Cut-off and accruals', conclusion: 'COMPLETE', evidenceIds: ['population-1'], adjustments: [adjustment],
  schedule: { type: 'CUT_OFF_ACCRUAL_DEFERRAL', applicability: 'APPLICABLE', rationale: 'Transactions straddling year end tested.', testedBeforeThrough: '2026-12-31', testedAfterThrough: '2027-01-31', populationEvidenceId: 'population-1', exceptionsResolved: true, items: [{ id: 'fee', category: 'ACCRUED_EXPENSE', serviceFrom: '2026-01-01', serviceThrough: '2026-12-31', amountCents: 10_000, calculationEvidenceId: 'calc-1', proposalId: 'adj-1' }] },
})

describe('HGB typed workpapers', () => {
  it('maps every close requirement to exactly one first-class schedule type', () => {
    expect(Object.keys(HGB_KIND_SCHEDULE_TYPE).sort()).toEqual([...HGB_WORKPAPER_KINDS].sort())
    expect(new Set(Object.values(HGB_KIND_SCHEDULE_TYPE)).size).toBe(HGB_WORKPAPER_KINDS.length)
  })

  it('validates a combined cut-off and accrual schedule with its deterministic balanced proposal', () => {
    const result = validateHgbWorkpaper(cutoff(), period)
    expect(result.adjustments[0]).toMatchObject({ id: 'adj-1', fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(result.adjustments[0].lines.map(line => line.accountId)).toEqual(['expense', 'liability'])
  })

  it('normalizes semantically identical adjustment ordering to one posting fingerprint', () => {
    const first = normalizeHgbAdjustment(adjustment, period)
    const second = normalizeHgbAdjustment({ ...adjustment, evidenceIds: [...adjustment.evidenceIds].reverse(), lines: [...adjustment.lines].reverse() }, period)
    expect(second.fingerprint).toBe(first.fingerprint)
  })

  it('fails closed for unbalanced, zero, outside-period, or unevidenced adjustment proposals', () => {
    expect(() => normalizeHgbAdjustment({ ...adjustment, bookingDate: '2027-01-01', evidenceIds: [], lines: [{ accountId: 'expense', debitCents: 1, creditCents: 0 }, { accountId: 'liability', debitCents: 0, creditCents: 2 }] }, period)).toThrow(/inside.*evidence.*balanced/i)
  })

  it('rejects a schedule that does not correspond to its required HGB workpaper kind', () => {
    expect(() => validateHgbWorkpaper({ ...cutoff(), kind: 'GOING_CONCERN' }, period)).toThrow(/requires the GOING_CONCERN schedule/)
  })

  it('fails closed for unsupported provision estimates and missing proposals for write-downs', () => {
    const provision: HgbWorkpaperDraft = { kind: 'PROVISIONS_AND_CONTINGENCIES', title: 'Provisions', conclusion: 'COMPLETE', evidenceIds: ['legal-1'], adjustments: [], schedule: { type: 'PROVISION_CONTINGENCY', applicability: 'APPLICABLE', rationale: 'Claims assessed', items: [{ id: 'claim', description: 'Claim', classification: 'PROVISION', obligationEvidenceId: 'legal-1', bestEstimateCents: 100, estimationMethod: 'external estimate', supportedEstimate: false }] } }
    expect(() => validateHgbWorkpaper(provision, period)).toThrow(/Unsupported provision estimates/)
    const receivable: HgbWorkpaperDraft = { kind: 'RECEIVABLE_AND_MARKET_VALUATION', title: 'Receivables', conclusion: 'COMPLETE', evidenceIds: ['ageing'], adjustments: [], schedule: { type: 'RECEIVABLE_MARKET_VALUATION', applicability: 'APPLICABLE', rationale: 'Ageing reviewed', items: [{ id: 'r1', accountId: 'receivables', grossCents: 1000, recoverableCents: 500, valuationEvidenceId: 'ageing' }] } }
    expect(() => validateHgbWorkpaper(receivable, period)).toThrow(/write-down requires an adjustment/)
  })

  it('requires a twelve-month forward going-concern assessment and fails closed on material uncertainty', () => {
    const input: HgbWorkpaperDraft = { kind: 'GOING_CONCERN', title: 'Going concern', conclusion: 'COMPLETE', evidenceIds: ['forecast'], adjustments: [], schedule: { type: 'GOING_CONCERN', applicability: 'APPLICABLE', rationale: 'Liquidity forecast assessed', assessmentThrough: '2027-12-30', forecastEvidenceId: 'forecast', goingConcernAppropriate: true, materialUncertainty: true } }
    expect(() => validateHgbWorkpaper(input, period)).toThrow(/twelve months.*material-uncertainty/i)
  })

  it('requires complete notes answers and exact asset and inventory GL reconciliation', () => {
    const notes: HgbWorkpaperDraft = { kind: 'NOTES', title: 'Notes', conclusion: 'COMPLETE', evidenceIds: ['notes'], adjustments: [], schedule: { type: 'NOTES_QUESTIONNAIRE', applicability: 'APPLICABLE', rationale: 'Small-company notes', notesRequired: true, questions: [{ id: 'policy', required: true, answer: 'YES' }] } }
    expect(() => validateHgbWorkpaper(notes, period)).toThrow(/disclosure text, and evidence/)
    const assets: HgbWorkpaperDraft = { kind: 'FIXED_ASSETS_AND_DEPRECIATION', title: 'Assets', conclusion: 'COMPLETE', evidenceIds: ['register'], adjustments: [], schedule: { type: 'FIXED_ASSET_VALUATION', applicability: 'APPLICABLE', rationale: 'Valuation engine outputs', valuationInputs: [], valuationResultIds: ['result-1'], allAssetsValued: true, glReconciled: false, reconciliationEvidenceId: 'register', proposalIds: [] } }
    expect(() => validateHgbWorkpaper(assets, period)).toThrow(/reconciled to the GL/)
  })

  it('binds fixed-asset workpapers to recomputed valuation amounts and exact posting proposals', () => {
    const valuationInput = { id: 'asset-1', description: 'Equipment', costBasisKind: 'ACQUISITION' as const, costComponents: [{ id: 'purchase', type: 'PURCHASE_PRICE' as const, amountCents: 1200, evidenceIds: ['purchase-evidence'] }], acquisitionDate: '2026-01-01', availableForUseDate: '2026-01-01', usefulLifeMonths: 12, depreciationConvention: 'FULL_MONTH' as const, residualValueCents: 0, fiscalPeriod: { start: '2026-01-01', end: '2026-12-31' }, priorCumulativeImpairmentCents: 0, glCarryingAmountCents: 0, accounts: { assetAccount: 'asset', expenseAccount: 'expense', incomeAccount: 'income' }, evidenceIds: ['asset-evidence'] }
    const input: HgbWorkpaperDraft = { kind: 'FIXED_ASSETS_AND_DEPRECIATION', title: 'Assets', conclusion: 'COMPLETE', evidenceIds: ['register', 'purchase-evidence', 'asset-evidence'], adjustments: [{ id: 'asset-1:DEPRECIATION', bookingDate: '2026-12-31', description: 'Depreciation', evidenceIds: ['asset-evidence'], lines: [{ accountId: 'expense', debitCents: 1200, creditCents: 0 }, { accountId: 'asset', debitCents: 0, creditCents: 1200 }] }], schedule: { type: 'FIXED_ASSET_VALUATION', applicability: 'APPLICABLE', rationale: 'Registered valuation engine', valuationInputs: [valuationInput], valuationResultIds: ['asset-1'], allAssetsValued: true, glReconciled: true, reconciliationEvidenceId: 'register', proposalIds: ['asset-1:DEPRECIATION'] } }
    expect(validateHgbWorkpaper(input, period).schedule).toMatchObject({ valuationResultIds: ['asset-1'], glReconciled: true })
    expect(() => validateHgbWorkpaper({ ...input, adjustments: [{ ...input.adjustments[0], lines: [{ accountId: 'expense', debitCents: 1100, creditCents: 0 }, { accountId: 'asset', debitCents: 0, creditCents: 1100 }] }] }, period)).toThrow(/deterministic amount/)
  })

  it('enforces evidence for micro omission and an independent preparer/reviewer lifecycle', () => {
    const micro: HgbWorkpaperDraft = { kind: 'MICRO_NOTES_OMISSION', title: 'Micro disclosures', conclusion: 'COMPLETE', evidenceIds: ['disclosure'], adjustments: [], schedule: { type: 'MICRO_NOTES_OMISSION', applicability: 'APPLICABLE', rationale: 'All omission conditions assessed', section268Paragraph7Disclosed: true, managementLoansDisclosed: false, additionalTrueAndFairDisclosureAssessed: true, evidenceId: 'disclosure' } }
    expect(() => validateHgbWorkpaper(micro, period)).toThrow(/Every micro-entity/)
    expect(() => assertHgbReview('person-a', 'person-a', 'APPROVE')).toThrow(/distinct/)
    expect(() => assertHgbReview('person-a', 'person-b', 'REJECT')).toThrow(/rejection reason/)
    expect(() => assertHgbReview('person-a', 'person-b', 'APPROVE')).not.toThrow()
  })
})
