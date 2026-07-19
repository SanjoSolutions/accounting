import { describe, expect, it } from 'vitest'
import { AnnualAdjustmentRuleRegistry, annualReturnDeadline, applicableAnnualReturns, createTestAnnualTaxLiabilityEvidence, prepareAnnualReturns, reconcileAnnualTax, reconcileAssessment, type AnnualTaxLiabilityEvidence, type AnnualTaxProfile, type TaxAdjustment } from './annualTax'
import { DeclarationWorkflow, createTestOfficialTaxGateway, submitWithGateway, taxFormRegistry, validateWithGateway } from './taxDeclarations'

const corporation: AnnualTaxProfile = { companyId: 'c1', legalForm: 'GMBH', tradeBusiness: true, establishments: 2, adviserExtension: false, fiscalYearEnd: '2026-12-31', municipalityCode: '11000000', tradeTaxMultiplierBasisPoints: 41000, establishmentAllocations: { Berlin: 60, Hamburg: 40 } }
const adjustment: TaxAdjustment = { id: 'adj-1', ruleVersion: 'KStG-2026.1', effectiveFor: '2026', field: 'STEUERLICHES_ERGEBNIS', layer: 'income-tax', amountCents: 10_000, reason: 'Non-deductible expense', sourceDocumentIds: ['doc-1'], legalBasis: 'KStG §10', treatment: 'add-back' }
const tradeAdjustment: TaxAdjustment = { id: 'trade-adj-1', ruleVersion: 'GewStG-2026.1', effectiveFor: '2026', field: 'GEWERBEERTRAG', layer: 'trade-tax', amountCents: 5_000, reason: 'Trade-tax add-back', sourceDocumentIds: ['doc-2'], legalBasis: 'GewStG §§8/9', treatment: 'add-back' }
const liability = (field: AnnualTaxLiabilityEvidence['field'], amountCents: number) => createTestAnnualTaxLiabilityEvidence({ taxpayerId: corporation.companyId, filingPeriod: '2026', field, amountCents })

describe('legal-form-specific annual tax returns', () => {
  it('selects KSt/GewSt/Zerlegung, ESt business schedules and partnership Feststellung from profile', () => {
    expect(applicableAnnualReturns(corporation)).toEqual(['KST', 'GEWST', 'ZERLEGUNG'])
    expect(applicableAnnualReturns({ ...corporation, legalForm: 'SOLE_PROPRIETOR', establishments: 1 })).toEqual(['EST_BUSINESS', 'GEWST'])
    expect(applicableAnnualReturns({ ...corporation, legalForm: 'KG', tradeBusiness: false })).toEqual(['FESTSTELLUNG'])
    expect(applicableAnnualReturns({ ...corporation, tradeBusiness: false, establishments: 1 })).toEqual(['KST', 'GEWST'])
    expect(() => applicableAnnualReturns({ ...corporation, legalForm: 'SOLE_PROPRIETOR', tradeBusiness: false, establishments: 1 })).toThrow(/unsupported non-business income schedule/)
    expect(() => applicableAnnualReturns({ ...corporation, legalForm: 'UNKNOWN' as never, tradeBusiness: false, establishments: 1 })).toThrow(/supported canonical discriminant/)
    for (const establishments of [0, -1, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) expect(() => applicableAnnualReturns({ ...corporation, establishments })).toThrow(/positive safe integer/)
  })

  it('keeps versioned tax adjustments distinct from HGB and reconciles fields to ledger/E-Bilanz/documents', () => {
    const result = reconcileAnnualTax({ taxpayerId: corporation.companyId, filingPeriod: '2026', hgbResultCents: 100_000, ledgerResultCents: 100_000, eBilanzResultCents: 100_000, adjustments: [adjustment, tradeAdjustment], liabilityEvidence: [liability('KST_SCHULD', 16_500), liability('GEWST_SCHULD', 17_250)], values: [{ field: 'STEUERLICHES_ERGEBNIS', amountCents: 110_000, ledgerEntryIds: ['entry-1'], eBilanzFacts: ['de-gaap-ci:is.netIncome'], adjustmentIds: ['adj-1'] }, { field: 'GEWERBEERTRAG', amountCents: 115_000, ledgerEntryIds: ['entry-2'], eBilanzFacts: [], adjustmentIds: ['trade-adj-1'] }, { field: 'KST_SCHULD', amountCents: 16_500, ledgerEntryIds: ['kst-liability'], eBilanzFacts: [], adjustmentIds: [] }, { field: 'GEWST_SCHULD', amountCents: 17_250, ledgerEntryIds: ['gewst-liability'], eBilanzFacts: [], adjustmentIds: [] }] })
    expect(result.ok).toBe(true)
    const datasets = prepareAnnualReturns(2026, corporation, result, taxFormRegistry)
    expect(datasets.map(dataset => dataset.kind)).toEqual(['KST', 'GEWST', 'ZERLEGUNG'])
    expect(datasets[0].drilldown.STEUERLICHES_ERGEBNIS).toEqual(['entry-1', 'de-gaap-ci:is.netIncome', 'adj-1'])
    expect(datasets[0].fields.KST_SCHULD).toBe(16_500)
    expect(datasets[0].drilldown.KST_SCHULD).toEqual(['kst-liability'])
    expect(datasets[1].fields).toMatchObject({ GEWERBEERTRAG: 115_000, GEWST_SCHULD: 17_250, GEMEINDE: '11000000', HEBESATZ_BP: 41000 })
    expect(datasets[1].drilldown.GEWST_SCHULD).toEqual(['gewst-liability'])
    expect(datasets[1].drilldown.GEWERBEERTRAG).toEqual(['entry-2', 'trade-adj-1'])
    expect(datasets[2].fields.ZERLEGUNGSANTEILE).toContain('Berlin')
    expect(Object.isFrozen(result.values[0].ledgerEntryIds)).toBe(true)
    expect(() => prepareAnnualReturns(2026, { ...corporation, municipalityCode: undefined }, result, taxFormRegistry)).toThrow(/municipality code/)
    expect(() => prepareAnnualReturns(2026, { ...corporation, municipalityCode: 'invalid' }, result, taxFormRegistry)).toThrow(/eight-digit municipality code/)
    expect(prepareAnnualReturns(2026, { ...corporation, municipalityCode: ' 11000000 ' }, result, taxFormRegistry).find(item => item.kind === 'GEWST')?.fields.GEMEINDE).toBe('11000000')
    expect(() => prepareAnnualReturns(2026, { ...corporation, companyId: 'other-company' }, result, taxFormRegistry)).toThrow(/taxpayer does not match/)
    expect(() => prepareAnnualReturns(2026, { ...corporation, fiscalYearEnd: '2026-02-30' }, result, taxFormRegistry)).toThrow(/real fiscal-year end/)
    expect(() => prepareAnnualReturns(2026, { ...corporation, fiscalYearEnd: '2025-12-31' }, result, taxFormRegistry)).toThrow(/requested four-digit assessment year/)
    expect(() => prepareAnnualReturns(2026, { ...corporation, establishmentAllocations: { Berlin: 60, Hamburg: 30 } }, result, taxFormRegistry)).toThrow(/totaling exactly 100/)
    expect(() => prepareAnnualReturns(2026, { ...corporation, establishmentAllocations: { ' ': 60, Hamburg: 40 } }, result, taxFormRegistry)).toThrow(/unique nonblank establishment IDs/)
  })

  it('reconciles the filed tax-result field without aggregating unrelated declaration values', () => {
    const result = reconcileAnnualTax({ taxpayerId: corporation.companyId, filingPeriod: '2026', hgbResultCents: 100_000, ledgerResultCents: 100_000, eBilanzResultCents: 100_000, adjustments: [adjustment], liabilityEvidence: [liability('KST_SCHULD', 16_500), liability('GEWST_SCHULD', 17_250)], values: [{ field: 'STEUERLICHES_ERGEBNIS', amountCents: 110_000, ledgerEntryIds: ['entry-1'], eBilanzFacts: [], adjustmentIds: ['adj-1'] }, { field: 'GEWERBEERTRAG', amountCents: 110_000, ledgerEntryIds: ['entry-trade'], eBilanzFacts: [], adjustmentIds: [] }, { field: 'KST_SCHULD', amountCents: 16_500, ledgerEntryIds: ['kst-liability'], eBilanzFacts: [], adjustmentIds: [] }, { field: 'GEWST_SCHULD', amountCents: 17_250, ledgerEntryIds: ['gewst-liability'], eBilanzFacts: [], adjustmentIds: [] }, { field: 'INFORMATIONAL_VALUE', amountCents: 900_000, ledgerEntryIds: ['entry-info'], eBilanzFacts: [], adjustmentIds: [] }] })
    expect(result.ok).toBe(true)
    expect(prepareAnnualReturns(2026, corporation, result, taxFormRegistry)[0].fields.STEUERLICHES_ERGEBNIS).toBe(110_000)
    const soleProprietor = { ...corporation, legalForm: 'SOLE_PROPRIETOR' as const, establishments: 1 }
    const soleResult = reconcileAnnualTax({ taxpayerId: corporation.companyId, filingPeriod: '2026', hgbResultCents: 100_000, ledgerResultCents: 100_000, eBilanzResultCents: 100_000, adjustments: [], liabilityEvidence: [liability('EST_SCHULD', 20_000), liability('GEWST_SCHULD', 15_000)], values: [{ field: 'STEUERLICHES_ERGEBNIS', amountCents: 100_000, ledgerEntryIds: ['entry-1'], eBilanzFacts: [], adjustmentIds: [] }, { field: 'GEWERBEERTRAG', amountCents: 100_000, ledgerEntryIds: ['entry-trade'], eBilanzFacts: [], adjustmentIds: [] }, { field: 'EST_SCHULD', amountCents: 20_000, ledgerEntryIds: ['est-liability'], eBilanzFacts: [], adjustmentIds: [] }, { field: 'GEWST_SCHULD', amountCents: 15_000, ledgerEntryIds: ['gewst-liability'], eBilanzFacts: [], adjustmentIds: [] }] })
    expect(prepareAnnualReturns(2026, soleProprietor, soleResult, taxFormRegistry)[0]).toMatchObject({ kind: 'EST_BUSINESS', fields: { EINKUENFTE_GEWERBEBETRIEB: 100_000, EST_SCHULD: 20_000 } })
  })

  it('blocks unreconciled or undocumented annual declarations', () => {
    const unattestedLiability = reconcileAnnualTax({ taxpayerId: corporation.companyId, filingPeriod: '2026', hgbResultCents: 0, ledgerResultCents: 0, eBilanzResultCents: 0, adjustments: [], values: [{ field: 'STEUERLICHES_ERGEBNIS', amountCents: 0, ledgerEntryIds: ['entry'], eBilanzFacts: [], adjustmentIds: [] }, { field: 'KST_SCHULD', amountCents: 999_999, ledgerEntryIds: ['claimed-liability'], eBilanzFacts: [], adjustmentIds: [] }] })
    expect(unattestedLiability.discrepancies).toContain('Field KST_SCHULD requires one exact authoritative liability calculation attestation.')
    const broken = reconcileAnnualTax({ filingPeriod: '2026', hgbResultCents: 100, ledgerResultCents: 99, eBilanzResultCents: 80, adjustments: [{ ...adjustment, sourceDocumentIds: [] }], values: [{ field: 'STEUERLICHES_ERGEBNIS', amountCents: 1, ledgerEntryIds: [], eBilanzFacts: [], adjustmentIds: ['missing'] }] })
    expect(broken.ok).toBe(false)
    expect(broken.discrepancies).toEqual(expect.arrayContaining([expect.stringContaining('HGB result differs'), expect.stringContaining('no drilldown'), expect.stringContaining('not documented')]))
    expect(() => prepareAnnualReturns(2026, corporation, broken, taxFormRegistry)).toThrow()
    const invalidPeriod = reconcileAnnualTax({ taxpayerId: corporation.companyId, filingPeriod: 'foo', hgbResultCents: 0, ledgerResultCents: 0, eBilanzResultCents: 0, adjustments: [], values: [{ field: 'STEUERLICHES_ERGEBNIS', amountCents: 0, ledgerEntryIds: ['entry'], eBilanzFacts: [], adjustmentIds: [] }] })
    expect(invalidPeriod).toMatchObject({ ok: false, discrepancies: expect.arrayContaining(['Annual tax reconciliation requires a canonical four-digit filing period.']) })
    const duplicate = reconcileAnnualTax({ filingPeriod: '2026', hgbResultCents: 100, ledgerResultCents: 100, eBilanzResultCents: 100, adjustments: [], values: [{ field: 'STEUERLICHES_ERGEBNIS', amountCents: 50, ledgerEntryIds: ['e1'], eBilanzFacts: [], adjustmentIds: [] }, { field: 'STEUERLICHES_ERGEBNIS', amountCents: 50, ledgerEntryIds: ['e2'], eBilanzFacts: [], adjustmentIds: [] }] })
    expect(duplicate.discrepancies).toContain('Declaration field STEUERLICHES_ERGEBNIS is duplicated.')
    const unused = reconcileAnnualTax({ filingPeriod: '2026', hgbResultCents: 100, ledgerResultCents: 100, eBilanzResultCents: 100, adjustments: [adjustment], values: [{ field: 'STEUERLICHES_ERGEBNIS', amountCents: 110_000, ledgerEntryIds: ['e1'], eBilanzFacts: [], adjustmentIds: [] }] })
    expect(unused.discrepancies).toContain('Adjustment adj-1 is not assigned to a declaration field.')
    const wrongPeriod = reconcileAnnualTax({ filingPeriod: '2025', hgbResultCents: 100_000, ledgerResultCents: 100_000, eBilanzResultCents: 100_000, adjustments: [adjustment], values: [{ field: 'STEUERLICHES_ERGEBNIS', amountCents: 110_000, ledgerEntryIds: ['e1'], eBilanzFacts: [], adjustmentIds: ['adj-1'] }] })
    expect(wrongPeriod.discrepancies).toContain('Adjustment adj-1 is not documented/versioned for filing period 2025.')
    const wrongFieldAdjustment = { ...adjustment, field: 'OTHER_FIELD' }
    const wrongField = reconcileAnnualTax({ filingPeriod: '2026', hgbResultCents: 100_000, ledgerResultCents: 100_000, eBilanzResultCents: 100_000, adjustments: [wrongFieldAdjustment], values: [{ field: 'STEUERLICHES_ERGEBNIS', amountCents: 110_000, ledgerEntryIds: ['e1'], eBilanzFacts: [], adjustmentIds: ['adj-1'] }] })
    expect(wrongField.discrepancies).toContain('Adjustment adj-1 targets OTHER_FIELD, not declaration field STEUERLICHES_ERGEBNIS.')
    const duplicateAdjustment = reconcileAnnualTax({ filingPeriod: '2026', hgbResultCents: 100, ledgerResultCents: 100, eBilanzResultCents: 100, adjustments: [adjustment, { ...adjustment }], values: [{ field: 'STEUERLICHES_ERGEBNIS', amountCents: 20_100, ledgerEntryIds: ['e1'], eBilanzFacts: [], adjustmentIds: ['adj-1'] }] })
    expect(duplicateAdjustment.discrepancies).toContain('Tax adjustment identifiers must be unique.')
    const unsafeMoney = reconcileAnnualTax({ filingPeriod: '2026', hgbResultCents: Number.NaN, ledgerResultCents: 0, eBilanzResultCents: 0, adjustments: [], values: [] })
    expect(unsafeMoney.discrepancies).toContain('Annual tax monetary values must be finite safe integer cents.')
    const duplicateUsage = reconcileAnnualTax({ filingPeriod: '2026', hgbResultCents: 0, ledgerResultCents: 0, eBilanzResultCents: 0, adjustments: [{ ...adjustment, amountCents: 0 }], values: [{ field: 'STEUERLICHES_ERGEBNIS', amountCents: 0, ledgerEntryIds: ['e1'], eBilanzFacts: [], adjustmentIds: ['adj-1', 'adj-1'] }] })
    expect(duplicateUsage.discrepancies).toContain('Adjustment adj-1 must be assigned to exactly one declaration field.')
    const overflow = reconcileAnnualTax({ filingPeriod: '2026', hgbResultCents: Number.MAX_SAFE_INTEGER, ledgerResultCents: Number.MAX_SAFE_INTEGER, eBilanzResultCents: Number.MAX_SAFE_INTEGER, adjustments: [{ ...adjustment, amountCents: 1 }], values: [{ field: 'STEUERLICHES_ERGEBNIS', amountCents: Number.MAX_SAFE_INTEGER, ledgerEntryIds: ['e1'], eBilanzFacts: [], adjustmentIds: ['adj-1'] }] })
    expect(overflow.discrepancies).toContain('Annual tax aggregate for STEUERLICHES_ERGEBNIS exceeds safe integer cents.')
    const blankProvenance = reconcileAnnualTax({ filingPeriod: '2026', hgbResultCents: 0, ledgerResultCents: 0, eBilanzResultCents: 0, adjustments: [{ ...adjustment, id: ' ', ruleVersion: ' ', legalBasis: ' ', sourceDocumentIds: [' '] }], values: [{ field: ' ', amountCents: 0, ledgerEntryIds: [' '], eBilanzFacts: [], adjustmentIds: [' '] }] })
    expect(blankProvenance.discrepancies).toEqual(expect.arrayContaining([expect.stringContaining('not documented/versioned'), expect.stringContaining('blank provenance identifiers')]))
    const wrongRule = reconcileAnnualTax({ filingPeriod: '2026', hgbResultCents: 0, ledgerResultCents: 0, eBilanzResultCents: 0, adjustments: [{ ...adjustment, amountCents: 0, legalBasis: 'invented' }], values: [{ field: 'STEUERLICHES_ERGEBNIS', amountCents: 0, ledgerEntryIds: ['e1'], eBilanzFacts: [], adjustmentIds: ['adj-1'] }] })
    expect(wrongRule.discrepancies).toContain('Adjustment adj-1 does not match an authoritative effective tax rule.')
    expect(() => reconcileAnnualTax({ filingPeriod: '2026', hgbResultCents: 0, ledgerResultCents: 0, eBilanzResultCents: 0, adjustments: [], values: [] }, Object.create(AnnualAdjustmentRuleRegistry.prototype))).toThrow(/authoritative adjustment-rule registry/)
    expect(() => reconcileAnnualTax({ filingPeriod: '2026', hgbResultCents: 0, ledgerResultCents: 0, eBilanzResultCents: 0, adjustments: [], values: [] }, new AnnualAdjustmentRuleRegistry([]))).toThrow(/authoritative adjustment-rule registry/)
    expect(() => prepareAnnualReturns(2026, corporation, { taxpayerId: corporation.companyId, filingPeriod: '2026', ok: true, values: [], discrepancies: [] }, taxFormRegistry)).toThrow(/verified reconciliation/)
    const genuine = reconcileAnnualTax({ filingPeriod: '2026', hgbResultCents: 0, ledgerResultCents: 0, eBilanzResultCents: 0, adjustments: [], values: [] })
    expect(() => prepareAnnualReturns(2026, corporation, { ...genuine }, taxFormRegistry)).toThrow(/exact verified/)
  })

  it('tracks deadlines/adviser extensions, assessment reconciliation, corrections and receipts through the common workflow', async () => {
    expect(annualReturnDeadline(2026, corporation)).toBe('2027-08-02')
    expect(annualReturnDeadline(2026, { ...corporation, adviserExtension: true })).toBe('2028-02-29')
    const gateway = createTestOfficialTaxGateway({ validate: async () => ({ valid: true, errors: [] }), submit: async () => ({ outcome: 'accepted', receipt: '<receipt/>' }), correct: async () => ({ outcome: 'accepted', receipt: '<correction/>' }), cancel: async () => ({ outcome: 'accepted', receipt: '<cancel/>' }), recover: async () => ({ outcome: 'accepted', receipt: '<receipt/>' }) })
    const validated = await validateWithGateway(DeclarationWorkflow.create(taxFormRegistry.prepare('KST', '2026', { STEUERLICHES_ERGEBNIS: 1_000_000, KST_SCHULD: 100 }, {}, corporation.companyId)), gateway)
    const accepted = await submitWithGateway(validated.approved('tax-user'), gateway)
    const assessment = { id: 'assessment-1', taxpayerId: corporation.companyId, kind: 'KST' as const, period: '2026', assessedAmountCents: 101, receivedAt: '2027-08-01', documentHash: 'a'.repeat(64), declarationSubmissionId: accepted.submissionId }
    expect(reconcileAssessment(assessment, accepted)).toMatchObject({ differenceCents: 1, needsReview: true })
    expect(() => reconcileAssessment({ ...assessment, receivedAt: '2000-01-01' }, accepted)).toThrow(/cannot predate.*accepted declaration submission/)
    expect(() => reconcileAssessment({ ...assessment, assessedAmountCents: Number.NaN }, accepted)).toThrow(/safe-integer cent operands/)
    expect(() => reconcileAssessment({ ...assessment, id: '', documentHash: 'hash', declarationSubmissionId: '', period: '2026-Q1', receivedAt: '2027-02-30' }, accepted)).toThrow(/valid identity.*provenance/)
    expect(() => reconcileAssessment({ ...assessment, taxpayerId: 'other-taxpayer' }, accepted)).toThrow(/exact accepted declaration.*same taxpayer/)
    expect(() => reconcileAssessment(assessment, { ...accepted } as DeclarationWorkflow)).toThrow(/exact accepted declaration/)
    expect(() => reconcileAssessment({ ...assessment, kind: 'ZERLEGUNG' }, accepted)).toThrow(/not supported for declaration kind ZERLEGUNG/)
    const correction = accepted.correction(taxFormRegistry.prepare('KST', '2026', { STEUERLICHES_ERGEBNIS: 99, KST_SCHULD: 10 }, {}, corporation.companyId))
    expect(correction.correction.correctsId).toBe(accepted.submissionId)
  })
})
