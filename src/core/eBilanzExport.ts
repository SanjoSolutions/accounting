import { createHash } from 'node:crypto'
import { canonicalJson } from './compliance/auditExport'
import type { EBalanceAssetScheduleRow } from './compliance/eBilanzLifecycle'
import { createFinancialStatements, type LedgerBalance } from './doubleEntry'
import { normalizeElsterTaxNumber, type EBalanceMasterData } from './eBilanz'
import { monetaryConcept, rollUpEBalanceFacts, type EBalanceTaxonomyModel } from './eBilanzTaxonomyModel'

export interface EBalanceTaxBalanceEvidence {
  schemaVersion: 'EBILANZ_TAX_BALANCE_V1'
  closeGenerationId: string
  sourceChecksum: string
  evidenceChecksum: string
  complete: true
  /** Balanced tax-only journal entries. These never mutate the commercial ledger. */
  adjustments: Array<{ id: string; description: string; evidenceIds: string[]; lines: Array<{ accountId: string; debitCents: number; creditCents: number }> }>
  assetMappings: Array<{ assetId: string; accountId: string }>
  bvv: { openingEquityCents: number; capitalAdjustmentsCents: number; contributionsCents: number; distributionsCents: number }
  gcd: {
    business: string
    country: 'DE'
    houseNumber: string
    previousPeriod: { start: string; end: string } | null
    domesticOrdinaryCompany: true
    shareholders: Array<{ id: string; name: string; legalStatus: 'NPP' | 'NPB' | 'PG' | 'KOER'; shareNumerator: number; shareDenominator: number; taxNumber: string | null; taxId: string | null; businessId: string | null }>
    businessId: string | null
  }
  /** Explicit reasons for unavailable GCD identifiers, rather than fabricated identifiers. */
  nilReasons: Record<string, string>
}

export interface ApprovedEBalanceReconciliation {
  id: string; ownerId: string; fiscalYearId: string; checksum: string; approvedBy: string; approvedAt: string
  evidenceIds: string[]; payload: EBalanceTaxBalanceEvidence
}

export interface EBalanceExportInput {
  ownerId: string
  sourceChecksum: string
  fiscalYear: { id: string; year: number; startsAt: string; endsAt: string }
  closeGeneration: { id: string; snapshotHash: string; hgbCloseRunChecksum: string; lockedAt: string }
  company: EBalanceMasterData
  balances: LedgerBalance[]
  reconciliation: ApprovedEBalanceReconciliation
  assets: Array<{ book: EBalanceAssetScheduleRow; tax: EBalanceAssetScheduleRow; acquisitionDate: string }>
}

export interface EBalanceExportFact { concept: string; context: 'instant' | 'duration'; amountCents: number | null; nilReason?: string }
export type EBalanceExportDataset = ReturnType<typeof createAuthoritativeEBalanceDataset>
export const eBalanceChecksum = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
export const reconciliationChecksum = (ownerId: string, fiscalYearId: string, payload: EBalanceTaxBalanceEvidence, evidenceIds: string[]) => eBalanceChecksum(canonicalJson({ ownerId, fiscalYearId, kind: 'TAX_BALANCE', payload, evidenceIds }))

function requireText(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value) throw new Error(`${name} must be nonblank canonical text.`)
}
function cents(value: number) { if (!Number.isSafeInteger(value)) throw new Error('Tax balance amounts must be safe integer cents.'); return value }
function sum(values: number[]) { return values.reduce((total, value) => cents(total + cents(value)), 0) }
function dateOnly(value: string) { if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error('Invalid fiscal date.'); return value }
function evidenceIds(ids: string[]) {
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) throw new Error('Unique reconciliation evidence IDs are required.')
  for (const id of ids) requireText(id, 'Evidence ID')
}

export function validateTaxBalanceEvidence(value: EBalanceTaxBalanceEvidence) {
  if (!value || value.schemaVersion !== 'EBILANZ_TAX_BALANCE_V1' || value.complete !== true) throw new Error('An explicit complete tax-balance reconciliation is required.')
  requireText(value.closeGenerationId, 'Close generation')
  if (!/^[0-9a-f]{64}$/.test(value.sourceChecksum) || !/^[0-9a-f]{64}$/.test(value.evidenceChecksum)) throw new Error('Reconciliation source and evidence checksums are required.')
  if (!Array.isArray(value.adjustments) || !Array.isArray(value.assetMappings) || !value.bvv || !value.gcd || !value.nilReasons || typeof value.nilReasons !== 'object') throw new Error('Tax-balance reconciliation is incomplete.')
  if (new Set(value.adjustments.map(row => row.id)).size !== value.adjustments.length) throw new Error('Duplicate tax adjustment ID.')
  for (const adjustment of value.adjustments) {
    requireText(adjustment.id, 'Adjustment ID'); requireText(adjustment.description, 'Adjustment description'); evidenceIds(adjustment.evidenceIds)
    if (!Array.isArray(adjustment.lines) || adjustment.lines.length < 2) throw new Error('Tax adjustments require balanced journal lines.')
    for (const line of adjustment.lines) {
      requireText(line.accountId, 'Adjustment account')
      if (cents(line.debitCents) < 0 || cents(line.creditCents) < 0 || (line.debitCents > 0) === (line.creditCents > 0)) throw new Error('Tax adjustment lines require one positive debit or credit.')
    }
    if (sum(adjustment.lines.map(line => line.debitCents - line.creditCents)) !== 0) throw new Error('Tax adjustment journal is not balanced.')
  }
  for (const name of ['openingEquityCents', 'capitalAdjustmentsCents', 'contributionsCents', 'distributionsCents'] as const) cents(value.bvv[name])
  if (value.bvv.contributionsCents < 0 || value.bvv.distributionsCents < 0) throw new Error('BVV contributions/distributions cannot be negative.')
  if (value.gcd.country !== 'DE' || value.gcd.domesticOrdinaryCompany !== true) throw new Error('Only ordinary domestic UG/GmbH tax balances are supported.')
  requireText(value.gcd.business, 'Business activity'); requireText(value.gcd.houseNumber, 'House number')
  if (value.gcd.previousPeriod) {
    if (dateOnly(value.gcd.previousPeriod.start) > dateOnly(value.gcd.previousPeriod.end)) throw new Error('Previous fiscal period is reversed.')
  }
  if (!Array.isArray(value.gcd.shareholders) || !value.gcd.shareholders.length) throw new Error('Shareholder GCD data is required.')
  let ownership = 0
  for (const shareholder of value.gcd.shareholders) {
    requireText(shareholder.id, 'Shareholder ID'); requireText(shareholder.name, 'Shareholder name')
    if (!['NPP', 'NPB', 'PG', 'KOER'].includes(shareholder.legalStatus) || !Number.isSafeInteger(shareholder.shareNumerator) || !Number.isSafeInteger(shareholder.shareDenominator) || shareholder.shareNumerator <= 0 || shareholder.shareDenominator <= 0) throw new Error('Shareholder legal form or ownership is invalid.')
    ownership += shareholder.shareNumerator / shareholder.shareDenominator
    for (const [key, identifier] of Object.entries({ taxNumber: shareholder.taxNumber, taxId: shareholder.taxId, businessId: shareholder.businessId })) {
      if (identifier !== null) requireText(identifier, `Shareholder ${key}`)
    }
  }
  if (value.gcd.businessId !== null) requireText(value.gcd.businessId, 'Company business identifier')
  if (Math.abs(ownership - 1) > 1e-12 || new Set(value.gcd.shareholders.map(s => s.id)).size !== value.gcd.shareholders.length) throw new Error('Shareholder ownership must total 100% with unique IDs.')
  for (const reason of Object.values(value.nilReasons)) requireText(reason, 'Nil reason')
  if (new Set(value.assetMappings.map(row => row.assetId)).size !== value.assetMappings.length) throw new Error('Duplicate asset taxonomy assignment.')
  for (const row of value.assetMappings) { requireText(row.assetId, 'Asset ID'); requireText(row.accountId, 'Asset account') }
  return value
}

export function createAuthoritativeEBalanceDataset(source: EBalanceExportInput, model: EBalanceTaxonomyModel) {
  // Capture once: consumers cannot change a retained generation through object aliases.
  const input = structuredClone(source)
  const { reconciliation: approval, fiscalYear, closeGeneration, company } = input
  requireText(input.ownerId, 'Tenant'); requireText(fiscalYear.id, 'Fiscal year'); requireText(closeGeneration.id, 'Close generation')
  const anniversary = new Date(dateOnly(fiscalYear.startsAt)); anniversary.setUTCFullYear(anniversary.getUTCFullYear() + 1)
  if (fiscalYear.startsAt > dateOnly(fiscalYear.endsAt) || Date.parse(fiscalYear.endsAt) >= anniversary.getTime()) throw new Error('Fiscal period is reversed or exceeds twelve months.')
  for (const checksum of [input.sourceChecksum, closeGeneration.snapshotHash, closeGeneration.hgbCloseRunChecksum]) if (!/^[0-9a-f]{64}$/.test(checksum)) throw new Error('Immutable close source checksums are required.')
  if (!Number.isFinite(Date.parse(closeGeneration.lockedAt))) throw new Error('A valid close lock timestamp is required.')
  if (!['UG', 'GMBH'].includes(company.legalForm)) throw new Error('This tax-balance export supports domestic UG and GmbH only.')
  for (const [name, value] of Object.entries(company)) requireText(value, name)
  company.taxNumber = normalizeElsterTaxNumber(company.taxNumber)
  if (fiscalYear.startsAt < model.release.validFrom || fiscalYear.startsAt > model.release.validThrough) throw new Error('Taxonomy is not applicable to the exact fiscal period.')
  const reconciliation = validateTaxBalanceEvidence(approval?.payload)
  if (approval.ownerId !== input.ownerId || approval.fiscalYearId !== fiscalYear.id || reconciliation.closeGenerationId !== closeGeneration.id) throw new Error('Reconciliation belongs to another tenant, fiscal year or close generation.')
  if (reconciliation.sourceChecksum !== input.sourceChecksum) throw new Error('Reconciliation is stale for the current close sources.')
  requireText(approval.id, 'Reconciliation ID'); requireText(approval.approvedBy, 'Approver')
  if (!Number.isFinite(Date.parse(approval.approvedAt)) || Date.parse(approval.approvedAt) < Date.parse(closeGeneration.lockedAt)) throw new Error('Reconciliation approval must follow the exact close generation.')
  evidenceIds(approval.evidenceIds)
  if (approval.checksum !== reconciliationChecksum(input.ownerId, fiscalYear.id, reconciliation, approval.evidenceIds)) throw new Error('Reconciliation checksum mismatch.')
  if (reconciliation.gcd.previousPeriod && reconciliation.gcd.previousPeriod.end >= fiscalYear.startsAt) throw new Error('Previous fiscal period overlaps the report.')
  const balances = input.balances
  if (!Array.isArray(balances) || !balances.length || new Set(balances.map(b => b.accountId)).size !== balances.length || new Set(balances.map(b => b.number)).size !== balances.length) throw new Error('Unique authoritative account balances are required.')
  const taxBalances = new Map(balances.map(balance => {
    requireText(balance.accountId, 'Account ID'); requireText(balance.name, 'Account name')
    if (!Number.isSafeInteger(balance.number) || !['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'].includes(balance.category)) throw new Error('Invalid authoritative account category or number.')
    if (cents(balance.debitCents) < 0 || cents(balance.creditCents) < 0 || cents(balance.balanceCents) !== cents(balance.debitCents - balance.creditCents)) throw new Error('Commercial account balance does not reconcile.')
    return [balance.accountId, { ...balance }]
  }))
  // Bound the aggregates before the shared statement reducer can lose precision.
  sum(balances.map(balance => balance.debitCents)); sum(balances.map(balance => balance.creditCents))
  for (const adjustment of reconciliation.adjustments) for (const line of adjustment.lines) {
    const account = taxBalances.get(line.accountId)
    if (!account) throw new Error(`Tax adjustment references unknown account ${line.accountId}.`)
    account.debitCents = cents(account.debitCents + line.debitCents); account.creditCents = cents(account.creditCents + line.creditCents)
    account.balanceCents = cents(account.debitCents - account.creditCents)
  }
  const commercial = createFinancialStatements(balances)
  sum([...taxBalances.values()].map(balance => balance.debitCents)); sum([...taxBalances.values()].map(balance => balance.creditCents))
  const tax = createFinancialStatements([...taxBalances.values()])
  if (commercial.balanceDifferenceCents !== 0 || tax.balanceDifferenceCents !== 0) throw new Error('Commercial and tax trial balances must balance.')
  const direct = new Map<string, number>()
  const accounts = balances.filter(b => b.debitCents !== 0 || b.creditCents !== 0 || taxBalances.get(b.accountId)!.balanceCents !== 0).map(balance => {
    if (!balance.eBilanzPosition) throw new Error(`Every used account requires an E-Bilanz mapping: ${balance.number}.`)
    const concept = monetaryConcept(model, balance.eBilanzPosition)
    const expectedPeriod = ['ASSET', 'LIABILITY', 'EQUITY'].includes(balance.category) ? 'instant' : 'duration'
    if (concept.period !== expectedPeriod || !['debit', 'credit'].includes(concept.balance)) throw new Error(`Account category/context disagrees with taxonomy: ${balance.number}.`)
    const taxBalance = taxBalances.get(balance.accountId)!
    const sign = concept.balance === 'credit' ? -1 : 1
    const amountCents = cents(taxBalance.balanceCents * sign)
    direct.set(concept.name, cents((direct.get(concept.name) ?? 0) + amountCents))
    return { ...balance, concept: concept.name, context: concept.period as 'instant' | 'duration',
      commercialAmountCents: cents(balance.balanceCents * sign), taxDebitCents: taxBalance.debitCents, taxCreditCents: taxBalance.creditCents, amountCents }
  }).sort((a, b) => a.number - b.number)
  // Result is a derived equity component, never a fabricated ledger account.
  if (direct.has('bs.eqLiab.equity.netIncome')) throw new Error('Mapping booked equity to the derived current net-income concept would double-count profit.')
  const income = rollUpEBalanceFacts(model, direct).get('is.netIncome') ?? 0
  if (income !== tax.netIncomeCents) throw new Error('Taxonomy profit/loss does not reconcile with account categories.')
  direct.set('bs.eqLiab.equity.netIncome', income)
  const rolled = rollUpEBalanceFacts(model, direct)
  rolled.set('is.netIncome', income)
  for (const [concept, expected] of [['bs.ass', tax.assetsCents], ['bs.eqLiab', tax.liabilitiesCents + tax.equityCents], ['bs.eqLiab.equity', tax.equityCents]] as const) {
    if ((rolled.get(concept) ?? 0) !== expected) throw new Error(`Taxonomy total ${concept} does not reconcile.`)
    rolled.set(concept, expected)
  }
  const bvv = reconciliation.bvv
  if (sum([tax.equityCents, -bvv.openingEquityCents, -bvv.capitalAdjustmentsCents, bvv.distributionsCents, -bvv.contributionsCents]) !== income) throw new Error('Tax BVV opening equity, contributions and distributions do not reconcile to the tax result.')
  for (const [concept, amount] of Object.entries({
    'BVV.profitLoss': income, 'BVV.profitLoss.assetsCurrentYear': tax.equityCents,
    'BVV.profitLoss.assetsPreviousYear': sum([bvv.openingEquityCents, bvv.capitalAdjustmentsCents]),
    'BVV.profitLoss.assetsPreviousYear.assets': bvv.openingEquityCents,
    'BVV.profitLoss.assetsPreviousYear.capAdjustments': bvv.capitalAdjustmentsCents,
    'BVV.profitLoss.withdrawalDistrib': bvv.distributionsCents, 'BVV.profitLoss.contribution': bvv.contributionsCents,
  })) rolled.set(concept, amount)
  const assets = input.assets.map(asset => {
    const mapping = reconciliation.assetMappings.find(row => row.assetId === asset.book.assetId)
    const account = accounts.find(row => row.accountId === mapping?.accountId)
    if (!account || !account.concept.startsWith('bs.ass.fixAss.') || asset.tax.assetId !== asset.book.assetId) throw new Error(`Asset ${asset.book.assetId} requires an explicit fixed-asset taxonomy assignment.`)
    for (const schedule of [asset.book, asset.tax]) {
      if (sum([schedule.openingCostCents, schedule.additionsCents, schedule.acquisitionCostTransfersCents, -schedule.disposalsCents]) !== schedule.closingCostCents
        || sum([schedule.openingAccumulatedDepreciationCents, schedule.currentDepreciationCents, schedule.impairmentsCents, -schedule.reversalsCents, schedule.accumulatedDepreciationTransfersCents, -schedule.depreciationRemovedOnDisposalCents]) !== schedule.closingAccumulatedDepreciationCents
        || sum([schedule.closingCostCents, -schedule.closingAccumulatedDepreciationCents]) !== schedule.carryingAmountCents) throw new Error('Asset movement schedule does not reconcile.')
    }
    return { ...asset, accountId: account.accountId, concept: account.concept }
  }).sort((a, b) => a.book.assetId.localeCompare(b.book.assetId))
  if (assets.length !== reconciliation.assetMappings.length) throw new Error('Asset assignments include unknown or missing assets.')
  for (const concept of new Set([...accounts.filter(account => account.concept.startsWith('bs.ass.fixAss.')).map(account => account.concept), ...assets.map(asset => asset.concept)])) {
    const rows = assets.filter(asset => asset.concept === concept)
    if (sum(rows.map(row => row.book.carryingAmountCents)) !== sum(accounts.filter(account => account.concept === concept).map(account => account.commercialAmountCents))
      || sum(rows.map(row => row.tax.carryingAmountCents)) !== sum(accounts.filter(account => account.concept === concept).map(account => account.amountCents))) throw new Error(`Asset schedule and ledger differ for ${concept}.`)
  }
  const facts: EBalanceExportFact[] = [...rolled].filter(([name]) => !model.concepts.get(`gaap:${name}`)?.abstract).map(([concept, amountCents]) => ({ concept, amountCents, context: monetaryConcept(model, concept).period as 'instant' | 'duration' }))
  for (const concept of model.concepts.values()) {
    if (concept.namespace === model.release.gaapNamespace && concept.required && !concept.abstract && concept.type === 'xbrli:monetaryItemType' && /^(bs\.|is\.|BVV\.)/.test(concept.name) && !facts.some(fact => fact.concept === concept.name)) {
      facts.push({ concept: concept.name, context: concept.period as 'instant' | 'duration', amountCents: null, nilReason: 'Not separately derivable from the complete mapped tax ledger.' })
    }
  }
  facts.sort((a, b) => a.concept.localeCompare(b.concept))
  return deepFreeze({ schemaVersion: 'EBILANZ_EXPORT_V1' as const, ownerId: input.ownerId, sourceChecksum: input.sourceChecksum, fiscalYear, closeGenerationId: closeGeneration.id,
    closeGeneration, company, taxonomy: { ...model.release }, generationDate: approval.approvedAt.slice(0, 10), accounts, facts, assets, reconciliation: approval,
    totals: { commercialNetIncomeCents: commercial.netIncomeCents, taxNetIncomeCents: income, taxAdjustmentCents: cents(income - commercial.netIncomeCents), assetsCents: tax.assetsCents, liabilitiesCents: tax.liabilitiesCents, equityCents: tax.equityCents },
    validationLevel: 'LOCAL_STRUCTURAL' as const, officialAcceptance: 'NOT_VALIDATED' as const })
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child) }
  return value
}
