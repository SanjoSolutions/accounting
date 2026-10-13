import { describe, expect, test } from 'vitest'
import { HGB_RULE_SET_2024, HGB_WORKPAPER_KINDS, classifyHgbSize, evaluateHgbClose, measureHgbSize, type HgbCloseProfile, type HgbCloseReadinessInput, type HgbWorkpaperEvidence } from './hgbClose'

const facts = (balanceSheetTotalCents: number, revenueCents: number, employees: number, microExcludedBySection267a = false) => ({ balanceSheetTotalCents, revenueCents, quarterlyEmployeeCounts: [employees, employees, employees, employees] as const, microExcludedBySection267a })
const profile = (patch: Partial<HgbCloseProfile> = {}): HgbCloseProfile => ({
  ruleSetVersion: HGB_RULE_SET_2024, legalForm: 'GMBH', fiscalPeriodStart: '2026-01-01', fiscalPeriodEnd: '2026-12-31', germanRegisteredEntity: true, groupStatus: 'STANDALONE_NO_EXEMPTION',
  publicInterestEntity: false, capitalMarketOrListed: false, regulatedIndustry: false, liquidationOrInsolvencyBasis: false, goingConcern: true,
  formedOrConvertedInCurrentPeriod: false, currentSizeFacts: facts(40_000_000, 80_000_000, 8), priorSizeFacts: facts(40_000_000, 80_000_000, 8), priorEstablishedSize: 'MICRO', hasInventory: false, hasFixedAssets: false, section5aApplies: false,
  microNotesOmission: { requiredSection268Paragraph7DisclosuresIncludedBelowBalanceSheet: true, advancesAndLoansToManagementDisclosedBelowBalanceSheet: true, requiredAdditionalTrueAndFairDisclosuresIncludedBelowBalanceSheet: true }, ...patch,
})
const reviewed = (kind: typeof HGB_WORKPAPER_KINDS[number]): HgbWorkpaperEvidence => ({ kind, conclusion: 'COMPLETE', evidenceIds: [`evidence:${kind}`], preparedBy: 'preparer', reviewedBy: 'reviewer', reviewedAt: '2027-03-01T10:00:00Z', ...(kind === 'GMBH_EQUITY_AND_RESULT' ? { section5aReserveApplicable: false } : {}) })
const readyInput = (): HgbCloseReadinessInput => ({ profile: profile(), workpapers: HGB_WORKPAPER_KINDS.filter(kind => !['INVENTORY_COUNT_AND_VALUATION', 'FIXED_ASSETS_AND_DEPRECIATION', 'NOTES'].includes(kind)).map(reviewed), annualAccountsPackageId: 'annual-1', annualAccountsChecksum: 'a'.repeat(64), ledgerFingerprint: 'b'.repeat(64), legalRepresentativeIds: ['director-1'], managingDirectorSignatures: [{ representativeId: 'director-1', signedAt: '2027-03-02T10:00:00Z', signatureEvidenceId: 'signature-1' }], shareholderResolutionId: 'resolution-1' })

describe('HGB size classification', () => {
  test('applies the statutory 2-of-3 micro and small thresholds at their inclusive boundaries', () => {
    expect(measureHgbSize(facts(45_000_000, 90_000_000, 11))).toBe('MICRO')
    expect(measureHgbSize(facts(750_000_000, 1_500_000_000, 51))).toBe('SMALL')
    expect(measureHgbSize(facts(750_000_001, 1_500_000_001, 50))).toBe('MEDIUM_OR_LARGE')
  })
  test('does not grant micro relief to an excluded entity and preserves the established class until two consecutive observations agree', () => {
    expect(measureHgbSize(facts(1, 1, 1, true))).toBe('SMALL')
    expect(classifyHgbSize(profile({ currentSizeFacts: facts(100, 100, 1), priorSizeFacts: facts(500_000_000, 1_000_000_000, 40), priorEstablishedSize: 'SMALL' }))).toBe('SMALL')
  })
  test('fails closed when transition history is absent', () => { expect(classifyHgbSize(profile({ priorSizeFacts: undefined }))).toBeUndefined() })
  test('moves a prior micro entity to small after two above-micro dates even when their measured buckets differ', () => { expect(classifyHgbSize(profile({ currentSizeFacts: facts(100_000_000, 100_000_000, 20), priorSizeFacts: facts(800_000_000, 100_000_000, 20), priorEstablishedSize: 'MICRO' }))).toBe('SMALL') })
})

describe('HGB close readiness', () => {
  test('accepts a fully evidenced micro GmbH within the explicit initial scope', () => { expect(evaluateHgbClose(readyInput())).toMatchObject({ status: 'READY_TO_LOCK', size: 'MICRO', notesRequired: false, managementReportRequired: false, statutoryAuditRequired: false, blockers: [] }) })
  test('requires notes when every micro omission condition is not evidenced', () => {
    const input = readyInput(); input.profile.microNotesOmission = undefined
    const result = evaluateHgbClose(input)
    expect(result.notesRequired).toBe(true); expect(result.blockers).toContainEqual(expect.objectContaining({ code: 'WORKPAPER_MISSING_OR_DUPLICATE', message: expect.stringContaining('NOTES') }))
  })
  test('fails closed for unsupported entities, periods, unknown inventory, and medium-or-large size', () => {
    const input = readyInput(); input.profile = profile({ legalForm: 'AG', publicInterestEntity: true, fiscalPeriodStart: '2023-01-01', fiscalPeriodEnd: '2023-12-31', hasInventory: null, currentSizeFacts: facts(800_000_000, 1_600_000_000, 300), priorSizeFacts: facts(800_000_000, 1_600_000_000, 300), priorEstablishedSize: 'SMALL' })
    expect(evaluateHgbClose(input).blockers.map(item => item.code)).toEqual(expect.arrayContaining(['ENTITY_SCOPE_UNSUPPORTED', 'PERIOD_SCOPE_UNSUPPORTED', 'SIZE_UNDETERMINED_OR_UNSUPPORTED', 'INVENTORY_APPLICABILITY_UNKNOWN']))
  })
  test('fails closed when applicability booleans are omitted or the fiscal start is beyond the validated rule horizon', () => {
    const input = readyInput(); input.profile = profile({ publicInterestEntity: undefined as never, hasFixedAssets: undefined as never, fiscalPeriodStart: '2027-01-01', fiscalPeriodEnd: '2027-12-31' })
    expect(evaluateHgbClose(input).blockers.map(item => item.code)).toEqual(expect.arrayContaining(['APPLICABILITY_FACTS_UNKNOWN', 'ENTITY_SCOPE_UNSUPPORTED', 'FIXED_ASSET_APPLICABILITY_UNKNOWN', 'PERIOD_SCOPE_UNSUPPORTED']))
  })
  test('rejects bare assertions without retained evidence and independent review', () => {
    const input = readyInput(); input.workpapers = input.workpapers.map((workpaper, index) => index ? workpaper : { ...workpaper, evidenceIds: [], reviewedBy: workpaper.preparedBy })
    expect(evaluateHgbClose(input).blockers.map(item => item.code)).toEqual(expect.arrayContaining(['WORKPAPER_EVIDENCE_MISSING', 'WORKPAPER_REVIEW_INVALID']))
  })
  test('blocks complex facts and incomplete immutable approval bindings', () => {
    const input = readyInput(); input.workpapers = input.workpapers.map((workpaper, index) => index ? workpaper : { ...workpaper, conclusion: 'UNSUPPORTED_COMPLEX_FACTS' as const }); input.ledgerFingerprint = undefined; input.shareholderResolutionId = undefined
    expect(evaluateHgbClose(input).blockers.map(item => item.code)).toEqual(expect.arrayContaining(['COMPLEX_FACTS_UNSUPPORTED', 'REQUIRED_WORKPAPER_INCOMPLETE', 'LEDGER_FINGERPRINT_MISSING', 'SHAREHOLDER_RESOLUTION_MISSING']))
  })
  test('turns malformed runtime workpaper data into stable blockers instead of throwing', () => {
    const input = readyInput(); input.workpapers = [null as never]
    expect(evaluateHgbClose(input).blockers.map(item => item.code)).toEqual(expect.arrayContaining(['WORKPAPER_MALFORMED', 'WORKPAPER_MISSING_OR_DUPLICATE']))
  })
  test('requires dated signatures from every recorded legal representative', () => {
    const input = readyInput(); input.legalRepresentativeIds = ['director-1', 'director-2']
    expect(evaluateHgbClose(input).blockers).toContainEqual(expect.objectContaining({ code: 'MANAGEMENT_SIGNATURES_MISSING' }))
  })
  test('fails closed when the reviewed equity workpaper contradicts the UG section 5a profile', () => {
    const input = readyInput(); input.profile = profile({ legalForm: 'UG', section5aApplies: true })
    expect(evaluateHgbClose(input).blockers).toContainEqual(expect.objectContaining({ code: 'SECTION_5A_APPLICABILITY_MISMATCH' }))
  })
  test('fails closed when the reviewed equity workpaper omits its section 5a conclusion', () => {
    const input = readyInput(); input.workpapers = input.workpapers.map(workpaper => workpaper.kind === 'GMBH_EQUITY_AND_RESULT' ? { ...workpaper, section5aReserveApplicable: undefined } : workpaper)
    expect(evaluateHgbClose(input).blockers).toContainEqual(expect.objectContaining({ code: 'SECTION_5A_APPLICABILITY_MISMATCH' }))
  })
})


test('Given eligible UG owner self-review, when evaluating the close, then the selected policy permits honest self-review without bypassing signatures, required workpapers or resolution', () => {
  const input = readyInput()
  input.profile = profile({ legalForm: 'UG' })
  input.reviewPolicy = { id: 'policy-1', checksum: 'a'.repeat(64), mode: 'OWNER_SELF_REVIEW', ownerId: 'owner', selectedBy: 'owner', selectedAt: '2027-01-15T10:00:00Z', version: 1, reason: 'Sole owner', evidenceIds: ['register'], soleShareholderManagingDirector: true, noAdditionalReviewRequirement: true }
  input.workpapers = input.workpapers.map(paper => ({ ...paper, preparedBy: 'owner', reviewedBy: 'owner', reviewMode: 'OWNER_SELF_REVIEW', reviewPolicyId: 'policy-1', reason: 'Explicit own re-examination' }))
  input.legalRepresentativeIds = ['owner']; input.managingDirectorSignatures = [{ representativeId: 'owner', signedAt: '2027-03-02T10:00:00Z', signatureEvidenceId: 'signature' }]
  expect(evaluateHgbClose(input).status).toBe('READY_TO_LOCK')
  expect(evaluateHgbClose({ ...input, reviewPolicy: { ...input.reviewPolicy, id: 'policy-2' } }).status).toBe('BLOCKED')
  expect(evaluateHgbClose({ ...input, workpapers: input.workpapers.slice(1) }).status).toBe('BLOCKED')
  expect(evaluateHgbClose({ ...input, managingDirectorSignatures: [] }).status).toBe('BLOCKED')
  expect(evaluateHgbClose({ ...input, shareholderResolutionId: '' }).status).toBe('BLOCKED')
  expect(evaluateHgbClose({ ...input, profile: profile() }).status).toBe('BLOCKED')
})
