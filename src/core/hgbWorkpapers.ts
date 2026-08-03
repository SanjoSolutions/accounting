import { createHash } from 'node:crypto'
import { classifyHgbSize, HGB_RULE_SET_2024, HGB_WORKPAPER_KINDS, type HgbCloseProfile, type HgbWorkpaperKind } from './hgbClose'
import { createHgbAssetValuation, createHgbInventorySchedule, createHgbInventoryValuation, createHgbSubledgerReconciliation, type HgbAssetValuationInput, type HgbInventoryValuationInput } from './compliance/hgbAssetInventoryValuation'

export const HGB_SCHEDULE_TYPES = [
  'OPENING_BALANCE', 'MAPPING_PRESENTATION', 'RECOGNITION_OWNERSHIP',
  'CUT_OFF_ACCRUAL_DEFERRAL', 'PROVISION_CONTINGENCY', 'RECEIVABLE_MARKET_VALUATION',
  'FIXED_ASSET_VALUATION', 'INVENTORY_VALUATION', 'SUBSEQUENT_EVENTS', 'GOING_CONCERN',
  'POLICY_ELECTIONS', 'NOTES_QUESTIONNAIRE', 'GMBH_EQUITY_RESULT',
  'MICRO_NOTES_OMISSION', 'SIZE_APPLICABILITY',
] as const
export type HgbScheduleType = typeof HGB_SCHEDULE_TYPES[number]
export type HgbWorkpaperStatus = 'DRAFT' | 'PREPARED' | 'REVIEWED' | 'REJECTED'

export interface HgbAdjustmentLine {
  accountId: string
  debitCents: number
  creditCents: number
  memo?: string
}

export interface HgbAdjustmentProposal {
  id: string
  bookingDate: string
  description: string
  evidenceIds: readonly string[]
  lines: readonly HgbAdjustmentLine[]
}

interface ScheduleBase {
  type: HgbScheduleType
  applicability: 'APPLICABLE' | 'NOT_APPLICABLE' | 'UNSUPPORTED'
  rationale: string
}

export interface OpeningBalanceSchedule extends ScheduleBase {
  type: 'OPENING_BALANCE'
  priorClosingFingerprint: string
  currentOpeningFingerprint: string
  reconciled: boolean
  reconciliationEvidenceId: string
  approvedComparativeLeaves: readonly { lineId: string; amountCents: number }[]
}
export interface MappingPresentationSchedule extends ScheduleBase {
  type: 'MAPPING_PRESENTATION'
  mappingVersionIds: readonly string[]
  allPostingAccountsMappedOnce: boolean
  presentationReviewed: boolean
  evidenceId: string
}

export interface RecognitionOwnershipSchedule extends ScheduleBase {
  type: 'RECOGNITION_OWNERSHIP'
  items: readonly { id: string; description: string; recognition: 'RECOGNIZE' | 'DO_NOT_RECOGNIZE'; ownershipEvidenceId: string; measurementBasis: string }[]
}
export interface CutOffAccrualDeferralSchedule extends ScheduleBase {
  type: 'CUT_OFF_ACCRUAL_DEFERRAL'
  testedBeforeThrough: string
  testedAfterThrough: string
  populationEvidenceId: string
  exceptionsResolved: boolean
  items: readonly { id: string; category: 'PREPAID_EXPENSE' | 'DEFERRED_INCOME' | 'ACCRUED_EXPENSE' | 'ACCRUED_INCOME'; serviceFrom: string; serviceThrough: string; amountCents: number; calculationEvidenceId: string; proposalId?: string }[]
}
export interface ProvisionContingencySchedule extends ScheduleBase {
  type: 'PROVISION_CONTINGENCY'
  items: readonly { id: string; description: string; classification: 'PROVISION' | 'CONTINGENT_LIABILITY' | 'NONE'; obligationEvidenceId: string; bestEstimateCents?: number; estimationMethod?: string; proposalId?: string; supportedEstimate: boolean }[]
}
export interface ReceivableMarketValuationSchedule extends ScheduleBase {
  type: 'RECEIVABLE_MARKET_VALUATION'
  items: readonly { id: string; accountId: string; grossCents: number; recoverableCents: number; valuationEvidenceId: string; proposalId?: string }[]
}
export interface SubsequentEventsSchedule extends ScheduleBase {
  type: 'SUBSEQUENT_EVENTS'
  searchThrough: string
  evidenceId: string
  events: readonly { id: string; description: string; treatment: 'ADJUSTING' | 'NON_ADJUSTING' | 'NO_EFFECT'; proposalId?: string; notesDisclosureRequired: boolean }[]
}
export interface GoingConcernSchedule extends ScheduleBase {
  type: 'GOING_CONCERN'
  assessmentThrough: string
  forecastEvidenceId: string
  goingConcernAppropriate: boolean
  materialUncertainty: boolean
}
export interface NotesQuestionnaireSchedule extends ScheduleBase {
  type: 'NOTES_QUESTIONNAIRE'
  notesRequired: boolean
  questions: readonly { id: string; required: boolean; answer: 'YES' | 'NO' | 'NOT_APPLICABLE'; disclosureText?: string; evidenceId?: string }[]
}
export interface PolicyElectionsSchedule extends ScheduleBase {
  type: 'POLICY_ELECTIONS'
  elections: readonly { id: string; policy: 'COST_METHOD' | 'TOTAL_COST_PNL' | 'FUNCTION_OF_EXPENSE_PNL' | 'FIFO' | 'LIFO' | 'WEIGHTED_AVERAGE'; selected: boolean; rationale: string; applicable: boolean }[]
}

export interface FixedAssetValuationSchedule extends ScheduleBase {
  type: 'FIXED_ASSET_VALUATION'
  valuationInputs: readonly HgbAssetValuationInput[]
  valuationResultIds: readonly string[]
  allAssetsValued: boolean
  glReconciled: boolean
  reconciliationEvidenceId: string
  proposalIds: readonly string[]
}
export interface InventoryValuationSchedule extends ScheduleBase {
  type: 'INVENTORY_VALUATION'
  expectedItemIds: readonly string[]
  valuationInputs: readonly HgbInventoryValuationInput[]
  valuationResultIds: readonly string[]
  countSnapshotId: string
  allItemsValued: boolean
  glReconciled: boolean
  reconciliationEvidenceId: string
  proposalIds: readonly string[]
}
export interface GmbhEquityResultSchedule extends ScheduleBase {
  type: 'GMBH_EQUITY_RESULT'
  shareCapitalCents: number
  resultCents: number
  equityReconciled: boolean
  section5aReserveApplicable: boolean
  reserveCalculationEvidenceId?: string
  evidenceId: string
  proposalIds: readonly string[]
}
export interface MicroNotesOmissionSchedule extends ScheduleBase {
  type: 'MICRO_NOTES_OMISSION'
  section268Paragraph7Disclosed: boolean
  managementLoansDisclosed: boolean
  additionalTrueAndFairDisclosureAssessed: boolean
  evidenceId: string
}
export interface SizeApplicabilitySchedule extends ScheduleBase {
  type: 'SIZE_APPLICABILITY'
  legalForm: 'GMBH' | 'UG'
  establishedSize: 'MICRO' | 'SMALL'
  currentFactsEvidenceId: string
  priorFactsEvidenceId: string
  standaloneNoExemption: boolean
  nonPieUnlistedUnregulated: boolean
  closeProfile: HgbCloseProfile
}

export type HgbTypedSchedule = OpeningBalanceSchedule | MappingPresentationSchedule | RecognitionOwnershipSchedule | CutOffAccrualDeferralSchedule | ProvisionContingencySchedule | ReceivableMarketValuationSchedule | FixedAssetValuationSchedule | InventoryValuationSchedule | SubsequentEventsSchedule | GoingConcernSchedule | NotesQuestionnaireSchedule | PolicyElectionsSchedule | GmbhEquityResultSchedule | MicroNotesOmissionSchedule | SizeApplicabilitySchedule

export const HGB_KIND_SCHEDULE_TYPE: Readonly<Record<HgbWorkpaperKind, HgbScheduleType>> = {
  OPENING_BALANCE: 'OPENING_BALANCE', MAPPING_AND_PRESENTATION: 'MAPPING_PRESENTATION', RECOGNITION_AND_OWNERSHIP: 'RECOGNITION_OWNERSHIP',
  CUT_OFF_AND_ACCRUAL_DEFERRAL: 'CUT_OFF_ACCRUAL_DEFERRAL', PROVISIONS_AND_CONTINGENCIES: 'PROVISION_CONTINGENCY', RECEIVABLE_AND_MARKET_VALUATION: 'RECEIVABLE_MARKET_VALUATION',
  FIXED_ASSETS_AND_DEPRECIATION: 'FIXED_ASSET_VALUATION', INVENTORY_COUNT_AND_VALUATION: 'INVENTORY_VALUATION', SUBSEQUENT_EVENTS: 'SUBSEQUENT_EVENTS', GOING_CONCERN: 'GOING_CONCERN',
  POLICY_ELECTIONS: 'POLICY_ELECTIONS', NOTES: 'NOTES_QUESTIONNAIRE', GMBH_EQUITY_AND_RESULT: 'GMBH_EQUITY_RESULT', MICRO_NOTES_OMISSION: 'MICRO_NOTES_OMISSION', SIZE_AND_APPLICABILITY: 'SIZE_APPLICABILITY',
}

export interface HgbWorkpaperDraft {
  kind: HgbWorkpaperKind
  title: string
  conclusion: 'COMPLETE' | 'NOT_APPLICABLE' | 'UNSUPPORTED_COMPLEX_FACTS'
  evidenceIds: readonly string[]
  schedule: HgbTypedSchedule
  adjustments: readonly HgbAdjustmentProposal[]
}

export interface HgbValidatedWorkpaper extends HgbWorkpaperDraft {
  evidenceIds: string[]
  adjustments: Array<HgbAdjustmentProposal & { fingerprint: string; lines: HgbAdjustmentLine[] }>
}

const dateOnly = /^\d{4}-\d{2}-\d{2}$/
function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !dateOnly.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}
function required(value: unknown, label: string, issues: string[]) {
  if (typeof value !== 'string' || !value.trim()) issues.push(`${label} is required.`)
}
function uniqueNonempty(values: readonly string[] | unknown, label: string, issues: string[]) {
  if (!Array.isArray(values) || !values.length || values.some(value => typeof value !== 'string' || !value.trim()) || new Set(values).size !== values.length) issues.push(`${label} must contain unique evidence references.`)
}
function safeMoney(value: unknown, label: string, issues: string[], nonnegative = false) {
  if (!Number.isSafeInteger(value) || nonnegative && Number(value) < 0) issues.push(`${label} must be ${nonnegative ? 'a nonnegative ' : 'a '}safe-integer cent amount.`)
}
function canonical(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  throw new TypeError('Workpaper content must be JSON-compatible.')
}
export const hgbWorkpaperChecksum = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')

export function normalizeHgbAdjustment(proposal: HgbAdjustmentProposal, period: { startsAt: string; endsAt: string }) {
  const issues: string[] = []
  required(proposal.id, 'Adjustment id', issues); required(proposal.description, 'Adjustment description', issues)
  if (!validDate(proposal.bookingDate) || proposal.bookingDate < period.startsAt || proposal.bookingDate > period.endsAt) issues.push('Adjustment booking date must be inside the authoritative fiscal period.')
  uniqueNonempty(proposal.evidenceIds, 'Adjustment evidence', issues)
  if (!Array.isArray(proposal.lines) || proposal.lines.length < 2) issues.push('Adjustment requires at least two lines.')
  const lines = Array.isArray(proposal.lines) ? proposal.lines.map(line => ({ accountId: typeof line.accountId === 'string' ? line.accountId.trim() : '', debitCents: line.debitCents, creditCents: line.creditCents, ...(line.memo?.trim() ? { memo: line.memo.trim() } : {}) })).sort((a, b) => a.accountId.localeCompare(b.accountId) || a.debitCents - b.debitCents || a.creditCents - b.creditCents || (a.memo ?? '').localeCompare(b.memo ?? '')) : []
  for (const [index, line] of lines.entries()) {
    required(line.accountId, `Adjustment line ${index + 1} account`, issues)
    safeMoney(line.debitCents, `Adjustment line ${index + 1} debit`, issues, true); safeMoney(line.creditCents, `Adjustment line ${index + 1} credit`, issues, true)
    if ((line.debitCents === 0) === (line.creditCents === 0)) issues.push(`Adjustment line ${index + 1} must contain exactly one positive debit or credit.`)
  }
  const debit = lines.reduce((sum, line) => sum + line.debitCents, 0); const credit = lines.reduce((sum, line) => sum + line.creditCents, 0)
  if (!Number.isSafeInteger(debit) || debit <= 0 || debit !== credit) issues.push('Adjustment must be balanced and nonzero.')
  if (issues.length) throw new TypeError(issues.join(' '))
  const normalized = { id: proposal.id.trim(), bookingDate: proposal.bookingDate, description: proposal.description.trim(), evidenceIds: [...proposal.evidenceIds].map(id => id.trim()).sort(), lines }
  return { ...normalized, fingerprint: hgbWorkpaperChecksum(normalized) }
}

function validateSchedule(schedule: HgbTypedSchedule, period: { startsAt: string; endsAt: string }, proposals: Map<string, HgbValidatedWorkpaper['adjustments'][number]>, issues: string[]) {
  if (!schedule || typeof schedule !== 'object' || !HGB_SCHEDULE_TYPES.includes(schedule.type)) { issues.push('A supported typed schedule is required.'); return }
  required(schedule.rationale, 'Schedule rationale', issues)
  if (!['APPLICABLE', 'NOT_APPLICABLE', 'UNSUPPORTED'].includes(schedule.applicability)) issues.push('Schedule applicability must be explicit.')
  if (schedule.applicability === 'UNSUPPORTED') issues.push('The schedule identifies facts outside the supported initial scope.')
  if (schedule.applicability === 'NOT_APPLICABLE') return
  const proposal = (id: string | undefined, label: string) => { if (id && !proposals.has(id)) issues.push(`${label} references an unknown adjustment proposal.`) }
  const exactValuationProposal = (generated: { id: string; amountCents: number; debitAccount: string; creditAccount: string; evidenceIds: readonly string[] }) => {
    const posted = proposals.get(generated.id)
    const debit = posted?.lines.find(line => line.accountId === generated.debitAccount && line.debitCents === generated.amountCents && line.creditCents === 0)
    const credit = posted?.lines.find(line => line.accountId === generated.creditAccount && line.debitCents === 0 && line.creditCents === generated.amountCents)
    if (!posted || posted.lines.length !== 2 || !debit || !credit || JSON.stringify([...posted.evidenceIds].sort()) !== JSON.stringify([...generated.evidenceIds].sort())) issues.push(`Valuation proposal ${generated.id} does not exactly match its deterministic amount, accounts, and evidence.`)
  }
  switch (schedule.type) {
    case 'OPENING_BALANCE':
      required(schedule.priorClosingFingerprint, 'Prior closing fingerprint', issues); required(schedule.currentOpeningFingerprint, 'Current opening fingerprint', issues); required(schedule.reconciliationEvidenceId, 'Opening reconciliation evidence', issues); if (!schedule.reconciled || schedule.priorClosingFingerprint !== schedule.currentOpeningFingerprint) issues.push('Opening balances must reconcile exactly to the prior closing fingerprint.');
      if (!Array.isArray(schedule.approvedComparativeLeaves) || !schedule.approvedComparativeLeaves.length || new Set(schedule.approvedComparativeLeaves.map(item => item.lineId)).size !== schedule.approvedComparativeLeaves.length || schedule.approvedComparativeLeaves.some(item => !item.lineId?.trim() || !Number.isSafeInteger(item.amountCents))) issues.push('Opening reconciliation requires unique approved comparative statement leaves with safe-integer cent amounts.'); break
    case 'MAPPING_PRESENTATION':
      uniqueNonempty(schedule.mappingVersionIds, 'Mapping versions', issues); required(schedule.evidenceId, 'Mapping evidence', issues); if (!schedule.allPostingAccountsMappedOnce || !schedule.presentationReviewed) issues.push('Every posting account must map exactly once and presentation must be reviewed.'); break
    case 'RECOGNITION_OWNERSHIP':
      if (!schedule.items.length) issues.push('Recognition schedule requires an assessed population.'); for (const item of schedule.items) { required(item.id, 'Recognition item id', issues); required(item.description, 'Recognition description', issues); required(item.ownershipEvidenceId, 'Ownership evidence', issues); required(item.measurementBasis, 'Measurement basis', issues) } break
    case 'CUT_OFF_ACCRUAL_DEFERRAL':
      if (!validDate(schedule.testedBeforeThrough) || schedule.testedBeforeThrough < period.endsAt || !validDate(schedule.testedAfterThrough) || schedule.testedAfterThrough <= period.endsAt) issues.push('Cut-off testing must explicitly straddle the fiscal-period end.'); required(schedule.populationEvidenceId, 'Cut-off population evidence', issues); if (!schedule.exceptionsResolved) issues.push('All cut-off exceptions must be resolved.')
      for (const item of schedule.items) { safeMoney(item.amountCents, 'Accrual amount', issues, true); if (item.amountCents <= 0 || !validDate(item.serviceFrom) || !validDate(item.serviceThrough) || item.serviceFrom > item.serviceThrough) issues.push('Accrual service period and positive amount are required.'); required(item.calculationEvidenceId, 'Accrual calculation evidence', issues); proposal(item.proposalId, 'Accrual item') } break
    case 'PROVISION_CONTINGENCY':
      for (const item of schedule.items) { required(item.obligationEvidenceId, 'Obligation evidence', issues); if (!item.supportedEstimate) issues.push('Unsupported provision estimates require manual specialist review outside this scope.'); if (item.classification === 'PROVISION') { safeMoney(item.bestEstimateCents, 'Provision best estimate', issues, true); required(item.estimationMethod, 'Provision estimation method', issues); if (!item.bestEstimateCents) issues.push('A provision requires a positive best estimate.'); proposal(item.proposalId, 'Provision item') } } break
    case 'RECEIVABLE_MARKET_VALUATION':
      for (const item of schedule.items) { required(item.accountId, 'Valuation account', issues); required(item.valuationEvidenceId, 'Valuation evidence', issues); safeMoney(item.grossCents, 'Gross receivable', issues, true); safeMoney(item.recoverableCents, 'Recoverable amount', issues, true); if (item.recoverableCents > item.grossCents) issues.push('Recoverable amount cannot exceed gross carrying amount.'); if (item.recoverableCents < item.grossCents && !item.proposalId) issues.push('A receivable write-down requires an adjustment proposal.'); proposal(item.proposalId, 'Valuation item') } break
    case 'SUBSEQUENT_EVENTS':
      if (!validDate(schedule.searchThrough) || schedule.searchThrough <= period.endsAt) issues.push('Subsequent-event search must extend beyond period end.'); required(schedule.evidenceId, 'Subsequent-event evidence', issues); for (const event of schedule.events) { if (event.treatment === 'ADJUSTING' && !event.proposalId) issues.push('An adjusting subsequent event requires a proposal.'); proposal(event.proposalId, 'Subsequent event') } break
    case 'GOING_CONCERN': {
      const minimum = new Date(`${period.endsAt}T00:00:00.000Z`); minimum.setUTCFullYear(minimum.getUTCFullYear() + 1)
      if (!validDate(schedule.assessmentThrough) || new Date(`${schedule.assessmentThrough}T00:00:00.000Z`) < minimum) issues.push('Going-concern assessment must cover at least twelve months after period end.'); required(schedule.forecastEvidenceId, 'Going-concern forecast evidence', issues); if (!schedule.goingConcernAppropriate || schedule.materialUncertainty) issues.push('Non-going-concern or material-uncertainty cases are outside the initial automated scope.'); break
    }
    case 'NOTES_QUESTIONNAIRE':
      if (schedule.notesRequired && (!schedule.questions.length || schedule.questions.some(question => question.required && (question.answer !== 'YES' || !question.disclosureText?.trim() || !question.evidenceId?.trim())))) issues.push('Every required notes question needs an affirmative answer, disclosure text, and evidence.'); break
    case 'POLICY_ELECTIONS':
      if (!schedule.elections.length || schedule.elections.some(election => election.applicable && (!election.selected || !election.rationale.trim()))) issues.push('Every applicable accounting-policy election must be selected and reasoned.'); break
    case 'FIXED_ASSET_VALUATION':
      try { const rows = schedule.valuationInputs.map(createHgbAssetValuation); const reconciliation = createHgbSubledgerReconciliation(rows, []); if (!rows.length || !schedule.allAssetsValued || !schedule.glReconciled || !reconciliation.canClose || JSON.stringify([...schedule.valuationResultIds].sort()) !== JSON.stringify(rows.map(row => row.assetId).sort())) issues.push('All fixed assets must be valued by the registered engine and reconciled to the GL.'); const generatedRows = rows.flatMap(row => row.proposals); const generated = generatedRows.map(item => item.id).sort(); if (JSON.stringify([...schedule.proposalIds].sort()) !== JSON.stringify(generated)) issues.push('Fixed-asset proposal IDs must exactly match the deterministic valuation results.'); generatedRows.forEach(exactValuationProposal) } catch (error) { issues.push(error instanceof Error ? error.message : 'Fixed-asset valuation failed.') }
      uniqueNonempty(schedule.valuationResultIds, 'Asset valuation results', issues); required(schedule.reconciliationEvidenceId, 'Asset reconciliation evidence', issues); for (const id of schedule.proposalIds) proposal(id, 'Asset valuation result'); break
    case 'INVENTORY_VALUATION':
      try { const rows = schedule.valuationInputs.map(createHgbInventoryValuation); const inventory = createHgbInventorySchedule(schedule.expectedItemIds, rows); const reconciliation = createHgbSubledgerReconciliation([], rows); if (!rows.length || !schedule.allItemsValued || !schedule.glReconciled || !inventory.complete || !inventory.reconciled || !reconciliation.canClose || JSON.stringify([...schedule.valuationResultIds].sort()) !== JSON.stringify(rows.map(row => row.itemId).sort())) issues.push('All inventory items must be valued by the registered engine and reconciled to the GL.'); const generatedRows = rows.flatMap(row => row.proposals); const generated = generatedRows.map(item => item.id).sort(); if (JSON.stringify([...schedule.proposalIds].sort()) !== JSON.stringify(generated)) issues.push('Inventory proposal IDs must exactly match the deterministic valuation results.'); generatedRows.forEach(exactValuationProposal) } catch (error) { issues.push(error instanceof Error ? error.message : 'Inventory valuation failed.') }
      uniqueNonempty(schedule.valuationResultIds, 'Inventory valuation results', issues); required(schedule.countSnapshotId, 'Inventory count snapshot', issues); required(schedule.reconciliationEvidenceId, 'Inventory reconciliation evidence', issues); for (const id of schedule.proposalIds) proposal(id, 'Inventory valuation result'); break
    case 'GMBH_EQUITY_RESULT':
      safeMoney(schedule.shareCapitalCents, 'Share capital', issues, true); safeMoney(schedule.resultCents, 'Result', issues); required(schedule.evidenceId, 'Equity evidence', issues); if (!schedule.equityReconciled) issues.push('GmbH equity and result must reconcile to the GL.'); if (schedule.section5aReserveApplicable) required(schedule.reserveCalculationEvidenceId, 'Section 5a reserve calculation evidence', issues); for (const id of schedule.proposalIds) proposal(id, 'Equity result'); break
    case 'MICRO_NOTES_OMISSION':
      required(schedule.evidenceId, 'Micro notes omission evidence', issues); if (!schedule.section268Paragraph7Disclosed || !schedule.managementLoansDisclosed || !schedule.additionalTrueAndFairDisclosureAssessed) issues.push('Every micro-entity notes-omission condition must be evidenced.'); break
    case 'SIZE_APPLICABILITY':
      required(schedule.currentFactsEvidenceId, 'Current size facts evidence', issues); required(schedule.priorFactsEvidenceId, 'Prior size facts evidence', issues); if (!schedule.standaloneNoExemption || !schedule.nonPieUnlistedUnregulated) issues.push('Entity applicability is outside the supported initial scope.'); if (!schedule.closeProfile || typeof schedule.closeProfile !== 'object') issues.push('The complete HGB close profile must be bound to the reviewed size and applicability workpaper.'); else if (schedule.closeProfile.legalForm !== schedule.legalForm || schedule.closeProfile.groupStatus !== 'STANDALONE_NO_EXEMPTION' || schedule.closeProfile.publicInterestEntity || schedule.closeProfile.capitalMarketOrListed || schedule.closeProfile.regulatedIndustry || classifyHgbSize(schedule.closeProfile) !== schedule.establishedSize) issues.push('The reviewed size and applicability fields must agree with the bound HGB close profile.'); break
  }
}

export function validateHgbWorkpaper(input: HgbWorkpaperDraft, period: { startsAt: string; endsAt: string }): HgbValidatedWorkpaper {
  const issues: string[] = []
  if (!input || typeof input !== 'object') throw new TypeError('Workpaper must be an object.')
  if (!HGB_WORKPAPER_KINDS.includes(input.kind)) issues.push('Workpaper kind is unsupported.')
  else if (input.schedule?.type !== HGB_KIND_SCHEDULE_TYPE[input.kind]) issues.push(`${input.kind} requires the ${HGB_KIND_SCHEDULE_TYPE[input.kind]} schedule.`)
  required(input.title, 'Workpaper title', issues); uniqueNonempty(input.evidenceIds, 'Workpaper evidence', issues)
  if (!['COMPLETE', 'NOT_APPLICABLE', 'UNSUPPORTED_COMPLEX_FACTS'].includes(input.conclusion)) issues.push('Workpaper conclusion is unsupported.')
  const normalizedAdjustments: HgbValidatedWorkpaper['adjustments'] = []
  const proposalIds = new Set<string>()
  for (const proposal of Array.isArray(input.adjustments) ? input.adjustments : []) {
    try { const normalized = normalizeHgbAdjustment(proposal, period); if (proposalIds.has(normalized.id)) issues.push('Adjustment proposal ids must be unique.'); proposalIds.add(normalized.id); normalizedAdjustments.push(normalized) } catch (error) { issues.push(error instanceof Error ? error.message : 'Adjustment is invalid.') }
  }
  validateSchedule(input.schedule, period, new Map(normalizedAdjustments.map(item => [item.id, item])), issues)
  if (input.conclusion === 'COMPLETE' && input.schedule?.applicability !== 'APPLICABLE') issues.push('A COMPLETE conclusion requires an applicable schedule.')
  if (input.conclusion === 'NOT_APPLICABLE' && input.schedule?.applicability !== 'NOT_APPLICABLE') issues.push('A NOT_APPLICABLE conclusion requires matching applicability.')
  if (input.conclusion === 'UNSUPPORTED_COMPLEX_FACTS' || input.schedule?.applicability === 'UNSUPPORTED') issues.push('Unsupported complex facts cannot be prepared for automated close.')
  if (issues.length) throw new TypeError(issues.join(' '))
  return { ...structuredClone(input), title: input.title.trim(), evidenceIds: [...input.evidenceIds].map(id => id.trim()).sort(), adjustments: normalizedAdjustments }
}

export function assertHgbReview(preparedBy: string, reviewerId: string, decision: 'APPROVE' | 'REJECT', reason?: string) {
  if (!preparedBy.trim()) throw new TypeError('Preparer is required.'); if (!reviewerId.trim()) throw new TypeError('Reviewer is required.'); if (preparedBy === reviewerId) throw new TypeError('Reviewer must be distinct from preparer.'); if (decision === 'REJECT' && !reason?.trim()) throw new TypeError('A rejection reason is required.')
}

export const HGB_WORKPAPER_RULE_SET = HGB_RULE_SET_2024
