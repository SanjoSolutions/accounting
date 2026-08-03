export const HGB_RULE_SET_2024 = 'HGB-DE-2024.1' as const

export type SupportedHgbLegalForm = 'GMBH' | 'UG'
export type SupportedHgbSize = 'MICRO' | 'SMALL'
export type HgbMeasuredSize = SupportedHgbSize | 'MEDIUM_OR_LARGE'

export interface HgbSizeObservation {
  balanceSheetTotalCents: number
  revenueCents: number
  quarterlyEmployeeCounts: readonly [number, number, number, number]
  microExcludedBySection267a: boolean
}

export interface HgbCloseProfile {
  ruleSetVersion: typeof HGB_RULE_SET_2024
  legalForm: SupportedHgbLegalForm | string
  fiscalPeriodStart: string
  fiscalPeriodEnd: string
  germanRegisteredEntity: boolean
  groupStatus: 'STANDALONE_NO_EXEMPTION' | 'PARENT' | 'SUBSIDIARY' | 'CONSOLIDATED' | 'SECTION_264_3_EXEMPTION' | 'UNKNOWN'
  publicInterestEntity: boolean
  capitalMarketOrListed: boolean
  regulatedIndustry: boolean
  liquidationOrInsolvencyBasis: boolean
  goingConcern: boolean
  formedOrConvertedInCurrentPeriod: boolean
  currentSizeFacts: HgbSizeObservation
  priorSizeFacts?: HgbSizeObservation
  priorEstablishedSize?: SupportedHgbSize
  hasInventory: boolean | null
  hasFixedAssets: boolean | null
  microNotesOmission?: {
    requiredSection268Paragraph7DisclosuresIncludedBelowBalanceSheet: boolean
    advancesAndLoansToManagementDisclosedBelowBalanceSheet: boolean
    requiredAdditionalTrueAndFairDisclosuresIncludedBelowBalanceSheet: boolean
  }
  section5aApplies: boolean
}

export const HGB_WORKPAPER_KINDS = [
  'OPENING_BALANCE', 'MAPPING_AND_PRESENTATION', 'RECOGNITION_AND_OWNERSHIP',
  'CUT_OFF_AND_ACCRUAL_DEFERRAL', 'PROVISIONS_AND_CONTINGENCIES',
  'RECEIVABLE_AND_MARKET_VALUATION', 'FIXED_ASSETS_AND_DEPRECIATION',
  'INVENTORY_COUNT_AND_VALUATION', 'SUBSEQUENT_EVENTS', 'GOING_CONCERN',
  'POLICY_ELECTIONS', 'NOTES', 'GMBH_EQUITY_AND_RESULT',
  'MICRO_NOTES_OMISSION', 'SIZE_AND_APPLICABILITY',
] as const
export type HgbWorkpaperKind = typeof HGB_WORKPAPER_KINDS[number]

export interface HgbWorkpaperEvidence {
  kind: HgbWorkpaperKind
  conclusion: 'COMPLETE' | 'NOT_APPLICABLE' | 'UNSUPPORTED_COMPLEX_FACTS'
  evidenceIds: readonly string[]
  preparedBy: string
  reviewedBy: string
  reviewedAt: string
  reason?: string
}

export interface HgbCloseReadinessInput {
  profile: HgbCloseProfile
  workpapers: readonly HgbWorkpaperEvidence[]
  annualAccountsPackageId?: string
  annualAccountsChecksum?: string
  ledgerFingerprint?: string
  legalRepresentativeIds?: readonly string[]
  managingDirectorSignatures?: readonly { representativeId: string; signedAt: string; signatureEvidenceId: string }[]
  shareholderResolutionId?: string
}

export interface HgbCloseBlocker { code: string; message: string; authority: string }
export interface HgbCloseReadiness {
  status: 'READY_TO_LOCK' | 'BLOCKED'
  ruleSetVersion: typeof HGB_RULE_SET_2024
  size?: SupportedHgbSize
  notesRequired?: boolean
  managementReportRequired?: false
  statutoryAuditRequired?: false
  blockers: HgbCloseBlocker[]
}

const authority = {
  scope: 'HGB §§ 264, 267, 267a, 316',
  period: 'HGB § 240 Abs. 2; EGHGB Art. 93',
  size: 'HGB §§ 267, 267a',
  inventory: 'HGB §§ 240, 241, 253, 256',
  recognition: 'HGB §§ 246-251',
  valuation: 'HGB §§ 252-256a',
  statements: 'HGB §§ 242-245, 264-275',
  approval: 'HGB § 245; GmbHG §§ 29, 42a; GmbHG § 5a Abs. 3',
} as const

const MICRO = { balanceSheetTotalCents: 45_000_000, revenueCents: 90_000_000, employees: 10 }
const SMALL = { balanceSheetTotalCents: 750_000_000, revenueCents: 1_500_000_000, employees: 50 }
const dateOnly = /^\d{4}-\d{2}-\d{2}$/

function realDate(value: string) {
  if (!dateOnly.test(value)) return undefined
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? parsed : undefined
}

function isTwelveMonthPeriod(startValue: string, endValue: string) {
  const start = realDate(startValue); const end = realDate(endValue)
  if (!start || !end || start > end) return false
  const expected = new Date(start); expected.setUTCFullYear(expected.getUTCFullYear() + 1); expected.setUTCDate(expected.getUTCDate() - 1)
  return expected.getTime() === end.getTime()
}

function validObservation(value: HgbSizeObservation | undefined) {
  return Boolean(value
    && Number.isSafeInteger(value.balanceSheetTotalCents) && value.balanceSheetTotalCents >= 0
    && Number.isSafeInteger(value.revenueCents) && value.revenueCents >= 0
    && Array.isArray(value.quarterlyEmployeeCounts) && value.quarterlyEmployeeCounts.length === 4
    && value.quarterlyEmployeeCounts.every(count => Number.isSafeInteger(count) && count >= 0)
    && typeof value.microExcludedBySection267a === 'boolean')
}

function meetsThreshold(facts: HgbSizeObservation, threshold: typeof MICRO) {
  const averageEmployees = facts.quarterlyEmployeeCounts.reduce((sum, count) => sum + count, 0) / 4
  return [facts.balanceSheetTotalCents <= threshold.balanceSheetTotalCents, facts.revenueCents <= threshold.revenueCents, averageEmployees <= threshold.employees].filter(Boolean).length >= 2
}

export function measureHgbSize(facts: HgbSizeObservation): HgbMeasuredSize {
  if (!validObservation(facts)) throw new TypeError('HGB size facts must contain nonnegative safe-integer monetary and quarterly employee values.')
  if (!facts.microExcludedBySection267a && meetsThreshold(facts, MICRO)) return 'MICRO'
  if (meetsThreshold(facts, SMALL)) return 'SMALL'
  return 'MEDIUM_OR_LARGE'
}

export function classifyHgbSize(profile: HgbCloseProfile): SupportedHgbSize | undefined {
  if (!validObservation(profile.currentSizeFacts)) return undefined
  const current = measureHgbSize(profile.currentSizeFacts)
  if (profile.formedOrConvertedInCurrentPeriod) return undefined
  if (!validObservation(profile.priorSizeFacts) || !profile.priorEstablishedSize) return undefined
  const prior = profile.priorSizeFacts!
  const currentMicro = !profile.currentSizeFacts.microExcludedBySection267a && meetsThreshold(profile.currentSizeFacts, MICRO)
  const priorMicro = !prior.microExcludedBySection267a && meetsThreshold(prior, MICRO)
  const currentSmall = meetsThreshold(profile.currentSizeFacts, SMALL); const priorSmall = meetsThreshold(prior, SMALL)
  if (profile.priorEstablishedSize === 'MICRO') {
    if (currentMicro || priorMicro) return 'MICRO'
    return currentSmall ? 'SMALL' : undefined
  }
  if (currentMicro && priorMicro) return 'MICRO'
  if (!currentSmall && !priorSmall) return undefined
  return current === 'MEDIUM_OR_LARGE' && !priorSmall ? undefined : 'SMALL'
}

function add(blockers: HgbCloseBlocker[], code: string, message: string, legalAuthority: string) { blockers.push({ code, message, authority: legalAuthority }) }
function hasEvidence(workpaper: HgbWorkpaperEvidence) { return Array.isArray(workpaper.evidenceIds) && workpaper.evidenceIds.length > 0 && workpaper.evidenceIds.every(id => typeof id === 'string' && Boolean(id.trim())) }
function validReview(workpaper: HgbWorkpaperEvidence) {
  return Boolean(typeof workpaper.preparedBy === 'string' && workpaper.preparedBy.trim()
    && typeof workpaper.reviewedBy === 'string' && workpaper.reviewedBy.trim()
    && workpaper.preparedBy !== workpaper.reviewedBy
    && typeof workpaper.reviewedAt === 'string' && realDate(workpaper.reviewedAt.slice(0, 10))
    && Number.isFinite(Date.parse(workpaper.reviewedAt)))
}

export function evaluateHgbClose(input: HgbCloseReadinessInput): HgbCloseReadiness {
  const blockers: HgbCloseBlocker[] = []
  const profile = input.profile
  if (profile.ruleSetVersion !== HGB_RULE_SET_2024) add(blockers, 'RULE_SET_UNSUPPORTED', 'No implemented HGB rule set matches this close configuration.', authority.period)
  const exactFlags = [profile.germanRegisteredEntity, profile.publicInterestEntity, profile.capitalMarketOrListed, profile.regulatedIndustry, profile.liquidationOrInsolvencyBasis, profile.goingConcern, profile.formedOrConvertedInCurrentPeriod, profile.section5aApplies]
  if (exactFlags.some(value => typeof value !== 'boolean')) add(blockers, 'APPLICABILITY_FACTS_UNKNOWN', 'Every legal-scope applicability fact must be answered explicitly.', authority.scope)
  if (!['GMBH', 'UG'].includes(profile.legalForm) || !profile.germanRegisteredEntity || profile.groupStatus !== 'STANDALONE_NO_EXEMPTION' || profile.publicInterestEntity !== false || profile.capitalMarketOrListed !== false || profile.regulatedIndustry !== false || profile.liquidationOrInsolvencyBasis !== false || profile.goingConcern !== true || profile.formedOrConvertedInCurrentPeriod !== false || profile.legalForm === 'GMBH' && profile.section5aApplies !== false) add(blockers, 'ENTITY_SCOPE_UNSUPPORTED', 'The initial HGB close scope is limited to standalone, German, non-PIE, unlisted and unregulated GmbH/UG entities on a going-concern basis, excluding formation and conversion periods.', authority.scope)
  if (!isTwelveMonthPeriod(profile.fiscalPeriodStart, profile.fiscalPeriodEnd) || profile.fiscalPeriodStart < '2024-01-01' || profile.fiscalPeriodStart > '2026-08-03') add(blockers, 'PERIOD_SCOPE_UNSUPPORTED', 'A twelve-month fiscal period beginning from 2024-01-01 through the rule set validation date 2026-08-03 is required.', authority.period)
  const size = classifyHgbSize(profile)
  if (!size) add(blockers, 'SIZE_UNDETERMINED_OR_UNSUPPORTED', 'Current and prior 2-of-3 size facts and the established prior classification are required; medium and large entities are not supported.', authority.size)
  if (typeof profile.hasInventory !== 'boolean') add(blockers, 'INVENTORY_APPLICABILITY_UNKNOWN', 'Inventory applicability must be explicitly determined.', authority.inventory)
  if (typeof profile.hasFixedAssets !== 'boolean') add(blockers, 'FIXED_ASSET_APPLICABILITY_UNKNOWN', 'Fixed-asset applicability must be explicitly determined.', authority.valuation)

  const notesRequired = size === 'MICRO' ? !profile.microNotesOmission || Object.values(profile.microNotesOmission).some(value => value !== true) : size === 'SMALL'
  const requiredKinds = HGB_WORKPAPER_KINDS.filter(kind => {
    if (kind === 'INVENTORY_COUNT_AND_VALUATION') return profile.hasInventory !== false
    if (kind === 'FIXED_ASSETS_AND_DEPRECIATION') return profile.hasFixedAssets !== false
    if (kind === 'NOTES') return notesRequired !== false
    if (kind === 'MICRO_NOTES_OMISSION') return size === 'MICRO' && notesRequired === false
    return true
  })
  const byKind = new Map<HgbWorkpaperKind, HgbWorkpaperEvidence[]>()
  if (!Array.isArray(input.workpapers)) add(blockers, 'WORKPAPERS_MALFORMED', 'HGB workpapers must be supplied as a complete structured collection.', authority.recognition)
  for (const workpaper of Array.isArray(input.workpapers) ? input.workpapers : []) {
    if (!workpaper || typeof workpaper !== 'object' || !HGB_WORKPAPER_KINDS.includes(workpaper.kind)) { add(blockers, 'WORKPAPER_MALFORMED', 'A workpaper contains an unsupported kind or malformed structure.', authority.recognition); continue }
    byKind.set(workpaper.kind, [...(byKind.get(workpaper.kind) ?? []), workpaper])
  }
  for (const kind of requiredKinds) {
    const matches = byKind.get(kind) ?? []
    if (matches.length !== 1) { add(blockers, 'WORKPAPER_MISSING_OR_DUPLICATE', `Exactly one current ${kind} workpaper is required.`, kind.includes('VALUATION') || kind.includes('PROVISION') ? authority.valuation : authority.recognition); continue }
    const workpaper = matches[0]
    if (workpaper.conclusion === 'UNSUPPORTED_COMPLEX_FACTS') add(blockers, 'COMPLEX_FACTS_UNSUPPORTED', `${kind} identified facts outside the implemented close scope.`, authority.scope)
    if (workpaper.conclusion !== 'COMPLETE') add(blockers, 'REQUIRED_WORKPAPER_INCOMPLETE', `${kind} must have a COMPLETE conclusion.`, authority.recognition)
    if (!hasEvidence(workpaper)) add(blockers, 'WORKPAPER_EVIDENCE_MISSING', `${kind} requires retained evidence references.`, authority.recognition)
    if (!validReview(workpaper)) add(blockers, 'WORKPAPER_REVIEW_INVALID', `${kind} requires a dated review by a person distinct from its preparer.`, authority.statements)
  }
  if (!input.annualAccountsPackageId?.trim() || !/^[a-f0-9]{64}$/i.test(input.annualAccountsChecksum ?? '')) add(blockers, 'ANNUAL_ACCOUNTS_PACKAGE_MISSING', 'A validated immutable annual-accounts package and checksum are required.', authority.statements)
  if (!/^[a-f0-9]{64}$/i.test(input.ledgerFingerprint ?? '')) add(blockers, 'LEDGER_FINGERPRINT_MISSING', 'The approved close must be bound to the current ledger, mappings, profile, and evidence fingerprint.', authority.statements)
  const representatives = input.legalRepresentativeIds
  const signatures = input.managingDirectorSignatures
  if (!Array.isArray(representatives) || !representatives.length || representatives.some(id => typeof id !== 'string' || !id.trim()) || new Set(representatives).size !== representatives.length
    || !Array.isArray(signatures) || signatures.length !== representatives.length || signatures.some(signature => !signature || typeof signature.representativeId !== 'string' || !representatives.includes(signature.representativeId) || typeof signature.signatureEvidenceId !== 'string' || !signature.signatureEvidenceId.trim() || typeof signature.signedAt !== 'string' || !Number.isFinite(Date.parse(signature.signedAt))) || new Set(signatures.map(signature => signature.representativeId)).size !== representatives.length) add(blockers, 'MANAGEMENT_SIGNATURES_MISSING', 'Every legal representative must provide dated signature evidence before establishment.', authority.approval)
  if (!input.shareholderResolutionId?.trim()) add(blockers, 'SHAREHOLDER_RESOLUTION_MISSING', 'Shareholder establishment and result-appropriation evidence is required.', authority.approval)
  return { status: blockers.length ? 'BLOCKED' : 'READY_TO_LOCK', ruleSetVersion: HGB_RULE_SET_2024, ...(size ? { size, notesRequired } : {}), ...(size && !blockers.some(item => item.code === 'ENTITY_SCOPE_UNSUPPORTED') ? { managementReportRequired: false as const, statutoryAuditRequired: false as const } : {}), blockers }
}
