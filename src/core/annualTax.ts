import type { DeclarationDataset, DeclarationKind, DeclarationWorkflow, FormRegistry } from './taxDeclarations'
import { TaxDeclarationError, germanNationalHolidays, isExactAcceptedDeclarationWorkflow, nextBusinessDay } from './taxDeclarations'

export type LegalForm = 'GMBH' | 'UG' | 'AG' | 'SOLE_PROPRIETOR' | 'GBR' | 'OHG' | 'KG' | 'GMBH_CO_KG'
export interface AnnualTaxProfile { companyId: string; legalForm: LegalForm; tradeBusiness: boolean; establishments: number; adviserExtension: boolean; fiscalYearEnd: string; municipalityCode?: string; tradeTaxMultiplierBasisPoints?: number; establishmentAllocations?: Readonly<Record<string, number>> }
export function parseAnnualTaxYear(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1000 || (value as number) > 9999) throw new TaxDeclarationError(['Annual tax year must be a four-digit calendar year.'])
  return value as number
}
export interface TaxAdjustment { id: string; ruleVersion: string; effectiveFor: string; field: string; layer: 'income-tax' | 'trade-tax'; amountCents: number; reason: string; sourceDocumentIds: readonly string[]; legalBasis: string; treatment: 'add-back' | 'deduction' }
export interface AnnualTaxValue { field: string; amountCents: number; ledgerEntryIds: readonly string[]; eBilanzFacts: readonly string[]; adjustmentIds: readonly string[] }
export function parseAnnualTaxValues(value: unknown): AnnualTaxValue[] {
  if (!Array.isArray(value)) throw new TaxDeclarationError(['Annual tax values must be an array.'])
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TaxDeclarationError([`Annual tax value ${index + 1} must be an object.`])
    const candidate = item as Partial<AnnualTaxValue>
    const lists = [candidate.ledgerEntryIds, candidate.eBilanzFacts, candidate.adjustmentIds]
    if (typeof candidate.field !== 'string' || !candidate.field.trim() || !Number.isSafeInteger(candidate.amountCents) || lists.some(list => !Array.isArray(list) || list.some(id => typeof id !== 'string' || !id.trim()) || new Set(list).size !== list.length)) throw new TaxDeclarationError([`Annual tax value ${index + 1} requires a field, safe-integer cents, and unique nonblank drilldown IDs.`])
    return { field: candidate.field, amountCents: candidate.amountCents!, ledgerEntryIds: [...candidate.ledgerEntryIds!], eBilanzFacts: [...candidate.eBilanzFacts!], adjustmentIds: [...candidate.adjustmentIds!] }
  })
}
export interface AnnualTaxLiabilityEvidence { taxpayerId: string; filingPeriod: string; field: 'KST_SCHULD' | 'GEWST_SCHULD' | 'EST_SCHULD'; amountCents: number; provider: string; calculationId: string }
export interface AnnualTaxLiabilityAuthority { configurationId: string; attest(claim: Omit<AnnualTaxLiabilityEvidence, 'provider' | 'calculationId'>): Promise<{ verified: boolean; calculationId?: string }> }
const trustedAnnualTaxLiabilityAuthorities = new WeakSet<object>()
const trustedAnnualTaxLiabilityEvidence = new WeakSet<object>()
export function createConfiguredAnnualTaxLiabilityAuthority(adapter: Omit<AnnualTaxLiabilityAuthority, 'configurationId'>, configurationId: string): AnnualTaxLiabilityAuthority { if (!configurationId.trim() || typeof adapter.attest !== 'function') throw new TaxDeclarationError(['A configured annual-tax liability calculation authority is required.']); const authority = Object.freeze({ configurationId, attest: adapter.attest.bind(adapter) }); trustedAnnualTaxLiabilityAuthorities.add(authority); return authority }
export async function attestAnnualTaxLiability(claim: Omit<AnnualTaxLiabilityEvidence, 'provider' | 'calculationId'>, authority: AnnualTaxLiabilityAuthority): Promise<AnnualTaxLiabilityEvidence> { if (!trustedAnnualTaxLiabilityAuthorities.has(authority) || !claim.taxpayerId.trim() || !/^\d{4}$/.test(claim.filingPeriod) || !['KST_SCHULD', 'GEWST_SCHULD', 'EST_SCHULD'].includes(claim.field) || !Number.isSafeInteger(claim.amountCents)) throw new TaxDeclarationError(['Annual-tax liability attestation requires an exact configured authority and canonical claim.']); const result = await authority.attest(Object.freeze({ ...claim })); if (!result.verified || !result.calculationId?.trim()) throw new TaxDeclarationError(['Annual-tax liability calculation was not authoritatively verified.']); const evidence = Object.freeze({ ...claim, provider: authority.configurationId, calculationId: result.calculationId }); trustedAnnualTaxLiabilityEvidence.add(evidence); return evidence }
export function createTestAnnualTaxLiabilityEvidence(claim: Omit<AnnualTaxLiabilityEvidence, 'provider' | 'calculationId'>): AnnualTaxLiabilityEvidence { if (process.env.NODE_ENV !== 'test' || !claim.taxpayerId.trim() || !/^\d{4}$/.test(claim.filingPeriod) || !['KST_SCHULD', 'GEWST_SCHULD', 'EST_SCHULD'].includes(claim.field) || !Number.isSafeInteger(claim.amountCents)) throw new TaxDeclarationError(['Test annual-tax liability evidence requires a canonical claim in the test environment.']); const evidence = Object.freeze({ ...claim, provider: 'test-tax-calculator', calculationId: `test:${claim.field}:${claim.amountCents}` }); trustedAnnualTaxLiabilityEvidence.add(evidence); return evidence }
export interface AnnualTaxReconciliation { taxpayerId: string; filingPeriod: string; ok: boolean; values: readonly AnnualTaxValue[]; discrepancies: readonly string[] }
const verifiedAnnualReconciliations = new WeakSet<object>()
export interface AnnualAdjustmentRule { ruleVersion: string; validFrom: string; validTo: string; field: string; layer: 'income-tax' | 'trade-tax'; legalBasis: string; treatment: 'add-back' | 'deduction' }
const trustedAnnualRuleRegistries = new WeakSet<object>()
export class AnnualAdjustmentRuleRegistry {
  readonly rules: readonly AnnualAdjustmentRule[]
  constructor(rules: readonly AnnualAdjustmentRule[]) { this.rules = deepFreeze(rules.map(rule => ({ ...rule }))) as readonly AnnualAdjustmentRule[]; Object.freeze(this) }
  resolve(version: string, period: string) { return this.rules.find(rule => rule.ruleVersion === version && rule.validFrom <= period && period <= rule.validTo) }
}
function authoritativeAnnualAdjustmentRules(rules: readonly AnnualAdjustmentRule[]) { const registry = new AnnualAdjustmentRuleRegistry(rules); trustedAnnualRuleRegistries.add(registry); return registry }
export const annualAdjustmentRules = authoritativeAnnualAdjustmentRules([
  { ruleVersion: 'KStG-2026.1', validFrom: '2026', validTo: '2026', field: 'STEUERLICHES_ERGEBNIS', layer: 'income-tax', legalBasis: 'KStG §10', treatment: 'add-back' },
  { ruleVersion: 'GewStG-2026.1', validFrom: '2026', validTo: '2026', field: 'GEWERBEERTRAG', layer: 'trade-tax', legalBasis: 'GewStG §§8/9', treatment: 'add-back' },
])

export function applicableAnnualReturns(profile: AnnualTaxProfile): DeclarationKind[] {
  if (!['GMBH', 'UG', 'AG', 'SOLE_PROPRIETOR', 'GBR', 'OHG', 'KG', 'GMBH_CO_KG'].includes(profile.legalForm)) throw new TaxDeclarationError(['Annual tax profile legal form must use a supported canonical discriminant.'])
  if (!Number.isSafeInteger(profile.establishments) || profile.establishments < 1) throw new TaxDeclarationError(['Annual tax establishments must be a positive safe integer.'])
  if (profile.legalForm === 'SOLE_PROPRIETOR' && !profile.tradeBusiness) throw new TaxDeclarationError(['Non-trading sole proprietors require an unsupported non-business income schedule.'])
  const corporation = ['GMBH', 'UG', 'AG'].includes(profile.legalForm)
  const partnership = ['GBR', 'OHG', 'KG', 'GMBH_CO_KG'].includes(profile.legalForm)
  const result: DeclarationKind[] = corporation ? ['KST'] : partnership ? ['FESTSTELLUNG'] : ['EST_BUSINESS']
  if (corporation || profile.tradeBusiness) result.push('GEWST')
  if ((corporation || profile.tradeBusiness) && profile.establishments > 1) result.push('ZERLEGUNG')
  return result
}

export function reconcileAnnualTax(args: { taxpayerId?: string; filingPeriod: string; hgbResultCents: number; ledgerResultCents: number; eBilanzResultCents: number; adjustments: readonly TaxAdjustment[]; values: readonly AnnualTaxValue[]; liabilityEvidence?: readonly AnnualTaxLiabilityEvidence[] }, ruleRegistry: AnnualAdjustmentRuleRegistry = annualAdjustmentRules): AnnualTaxReconciliation {
  const discrepancies: string[] = []
  if (!args.taxpayerId?.trim()) discrepancies.push('Annual tax reconciliation requires a canonical taxpayer identity.')
  if (!/^\d{4}$/.test(args.filingPeriod)) discrepancies.push('Annual tax reconciliation requires a canonical four-digit filing period.')
  if (!trustedAnnualRuleRegistries.has(ruleRegistry)) throw new TaxDeclarationError(['Annual tax reconciliation requires an authoritative adjustment-rule registry.'])
  const monetaryValuesSafe = [args.hgbResultCents, args.ledgerResultCents, args.eBilanzResultCents, ...args.adjustments.map(item => item.amountCents), ...args.values.map(item => item.amountCents)].every(Number.isSafeInteger)
  if (!monetaryValuesSafe) discrepancies.push('Annual tax monetary values must be finite safe integer cents.')
  if (new Set(args.adjustments.map(adjustment => adjustment.id)).size !== args.adjustments.length) discrepancies.push('Tax adjustment identifiers must be unique.')
  if (monetaryValuesSafe && args.hgbResultCents !== args.ledgerResultCents) discrepancies.push('HGB result differs from the ledger result.')
  if (monetaryValuesSafe && args.eBilanzResultCents !== args.hgbResultCents) discrepancies.push('E-Bilanz result differs from the HGB result.')
  const incomeSources = args.values.filter(item => item.field === 'STEUERLICHES_ERGEBNIS')
  if (incomeSources.length === 0) discrepancies.push('Declaration requires exactly one STEUERLICHES_ERGEBNIS filed source field.')
  if (incomeSources.length === 1) {
    const adjustmentTotal = safeAggregate(args.adjustments.filter(item => item.layer === 'income-tax').map(item => item.amountCents))
    const expected = adjustmentTotal === undefined ? undefined : safeAggregate([args.hgbResultCents, adjustmentTotal])
    if (monetaryValuesSafe && expected === undefined) discrepancies.push('Annual tax aggregate for STEUERLICHES_ERGEBNIS exceeds safe integer cents.')
    else if (incomeSources[0].amountCents !== expected) discrepancies.push('Filed STEUERLICHES_ERGEBNIS does not reconcile to HGB plus income-tax adjustments.')
  }
  const tradeSources = args.values.filter(item => item.field === 'GEWERBEERTRAG')
  if (tradeSources.length === 1 && incomeSources.length === 1) {
    const adjustmentTotal = safeAggregate(args.adjustments.filter(item => item.layer === 'trade-tax').map(item => item.amountCents))
    const expected = adjustmentTotal === undefined ? undefined : safeAggregate([incomeSources[0].amountCents, adjustmentTotal])
    if (monetaryValuesSafe && expected === undefined) discrepancies.push('Annual tax aggregate for GEWERBEERTRAG exceeds safe integer cents.')
    else if (tradeSources[0].amountCents !== expected) discrepancies.push('Filed GEWERBEERTRAG does not reconcile from STEUERLICHES_ERGEBNIS plus trade-tax adjustments.')
  }
  const known = new Set(args.adjustments.map(item => item.id))
  const liabilityFields = new Set(['KST_SCHULD', 'GEWST_SCHULD', 'EST_SCHULD'])
  const liabilityEvidence = args.liabilityEvidence ?? []
  for (const value of args.values.filter(item => liabilityFields.has(item.field))) { const matches = liabilityEvidence.filter(item => item.field === value.field); if (matches.length !== 1 || !trustedAnnualTaxLiabilityEvidence.has(matches[0]) || matches[0].taxpayerId !== args.taxpayerId || matches[0].filingPeriod !== args.filingPeriod || matches[0].amountCents !== value.amountCents) discrepancies.push(`Field ${value.field} requires one exact authoritative liability calculation attestation.`) }
  if (liabilityEvidence.some(item => !args.values.some(value => value.field === item.field && value.amountCents === item.amountCents))) discrepancies.push('Annual-tax liability evidence must correspond to an exact declaration value.')
  const seenFields = new Set<string>()
  for (const value of args.values) {
    if (!value.field.trim()) discrepancies.push('Annual declaration field identifiers must be nonblank.')
    if ([...value.ledgerEntryIds, ...value.eBilanzFacts, ...value.adjustmentIds].some(id => !id.trim())) discrepancies.push(`Field ${value.field || '(blank)'} contains blank provenance identifiers.`)
    if (seenFields.has(value.field)) discrepancies.push(`Declaration field ${value.field} is duplicated.`)
    seenFields.add(value.field)
    if (!value.ledgerEntryIds.length && !value.eBilanzFacts.length && !value.adjustmentIds.some(id => known.has(id)) && !(value.field === 'HGB_RESULT' && value.amountCents === 0 && args.hgbResultCents === 0 && args.ledgerResultCents === 0)) discrepancies.push(`Field ${value.field} has no drilldown source.`)
    if (value.adjustmentIds.some(id => !known.has(id))) discrepancies.push(`Field ${value.field} references an unknown adjustment.`)
    for (const id of value.adjustmentIds) { const adjustment = args.adjustments.find(item => item.id === id); if (adjustment && adjustment.field !== value.field) discrepancies.push(`Adjustment ${id} targets ${adjustment.field}, not declaration field ${value.field}.`) }
  }
  const adjustmentUsage = new Map<string, number>()
  for (const id of args.values.flatMap(value => [...value.adjustmentIds])) adjustmentUsage.set(id, (adjustmentUsage.get(id) ?? 0) + 1)
  for (const adjustment of args.adjustments) {
    if (!adjustment.id.trim() || !adjustment.field.trim() || !adjustment.ruleVersion.trim() || adjustment.effectiveFor !== args.filingPeriod || !adjustment.reason.trim() || !adjustment.legalBasis.trim() || !adjustment.sourceDocumentIds.length || adjustment.sourceDocumentIds.some(id => !id.trim())) discrepancies.push(`Adjustment ${adjustment.id || '(blank)'} is not documented/versioned for filing period ${args.filingPeriod}.`)
    const usage = adjustmentUsage.get(adjustment.id) ?? 0
    if (usage === 0) discrepancies.push(`Adjustment ${adjustment.id} is not assigned to a declaration field.`)
    else if (usage > 1) discrepancies.push(`Adjustment ${adjustment.id} must be assigned to exactly one declaration field.`)
    const rule = ruleRegistry.resolve(adjustment.ruleVersion, args.filingPeriod)
    if (!rule || rule.field !== adjustment.field || rule.layer !== adjustment.layer || rule.legalBasis !== adjustment.legalBasis || rule.treatment !== adjustment.treatment || (rule.treatment === 'add-back' && adjustment.amountCents < 0) || (rule.treatment === 'deduction' && adjustment.amountCents > 0)) discrepancies.push(`Adjustment ${adjustment.id} does not match an authoritative effective tax rule.`)
  }
  const result = deepFreeze({ taxpayerId: args.taxpayerId ?? '', filingPeriod: args.filingPeriod, ok: discrepancies.length === 0, values: args.values.map(value => ({ ...value, ledgerEntryIds: [...value.ledgerEntryIds], eBilanzFacts: [...value.eBilanzFacts], adjustmentIds: [...value.adjustmentIds] })), discrepancies }) as AnnualTaxReconciliation
  verifiedAnnualReconciliations.add(result)
  return result
}

export function prepareAnnualReturns(year: number, profile: AnnualTaxProfile, reconciliation: AnnualTaxReconciliation, registry: FormRegistry): DeclarationDataset[] {
  if (!Number.isSafeInteger(year) || year < 1000 || year > 9999 || !isRealIsoDate(profile.fiscalYearEnd) || !profile.fiscalYearEnd.startsWith(`${year}-`)) throw new TaxDeclarationError(['Annual returns require a real fiscal-year end in the requested four-digit assessment year.'])
  if (!verifiedAnnualReconciliations.has(reconciliation)) throw new TaxDeclarationError(['Annual returns require the exact verified reconciliation result instance.'])
  if (!reconciliation.ok) throw new TaxDeclarationError(reconciliation.discrepancies)
  if (reconciliation.taxpayerId !== profile.companyId) throw new TaxDeclarationError(['Annual tax reconciliation taxpayer does not match the filing profile company.'])
  if (reconciliation.filingPeriod !== String(year)) throw new TaxDeclarationError(['Annual tax reconciliation belongs to a different filing period.'])
  const source = reconciliation.values.find(value => value.field === 'STEUERLICHES_ERGEBNIS')
  if (!source) throw new TaxDeclarationError(['Annual returns require a reconciled STEUERLICHES_ERGEBNIS source field.'])
  const provenance = [...source.ledgerEntryIds, ...source.eBilanzFacts, ...source.adjustmentIds]
  const tradeSource = reconciliation.values.find(value => value.field === 'GEWERBEERTRAG')
  const tradeProvenance = tradeSource ? [...tradeSource.ledgerEntryIds, ...tradeSource.eBilanzFacts, ...tradeSource.adjustmentIds] : []
  const kstLiability = reconciliation.values.find(value => value.field === 'KST_SCHULD')
  const gewstLiability = reconciliation.values.find(value => value.field === 'GEWST_SCHULD')
  const estLiability = reconciliation.values.find(value => value.field === 'EST_SCHULD')
  return applicableAnnualReturns(profile).map(kind => {
    if (kind === 'GEWST') { if (!tradeSource || !gewstLiability) throw new TaxDeclarationError(['GewSt requires separately reconciled GEWERBEERTRAG and GEWST_SCHULD source fields.']); const municipalityCode = profile.municipalityCode?.trim(); if (!municipalityCode || !/^\d{8}$/.test(municipalityCode) || !Number.isSafeInteger(profile.tradeTaxMultiplierBasisPoints) || profile.tradeTaxMultiplierBasisPoints! <= 0) throw new TaxDeclarationError(['GewSt requires a canonical eight-digit municipality code and positive multiplier basis points.']); return registry.prepare(kind, String(year), { GEWERBEERTRAG: tradeSource.amountCents, GEWST_SCHULD: gewstLiability.amountCents, GEMEINDE: municipalityCode, HEBESATZ_BP: profile.tradeTaxMultiplierBasisPoints! }, { GEWERBEERTRAG: tradeProvenance, GEWST_SCHULD: [...gewstLiability.ledgerEntryIds, ...gewstLiability.eBilanzFacts, ...gewstLiability.adjustmentIds] }, profile.companyId) }
    if (kind === 'ZERLEGUNG') { if (!tradeSource) throw new TaxDeclarationError(['Zerlegung requires a separately reconciled GEWERBEERTRAG source field.']); const allocations = profile.establishmentAllocations; const entries = allocations ? Object.entries(allocations) : []; const establishmentIds = entries.map(([id]) => id.trim()); const allocationTotal = safeAggregate(entries.map(([, value]) => value)); if (!allocations || entries.length !== profile.establishments || establishmentIds.some(id => !id) || new Set(establishmentIds).size !== establishmentIds.length || entries.some(([, value]) => !Number.isSafeInteger(value) || value < 0) || allocationTotal !== 100) throw new TaxDeclarationError(['Zerlegung requires unique nonblank establishment IDs and non-negative allocations totaling exactly 100.']); return registry.prepare(kind, String(year), { GEWERBEERTRAG: tradeSource.amountCents, ZERLEGUNGSANTEILE: JSON.stringify(Object.fromEntries(entries.map(([id, value]) => [id.trim(), value]))) }, { GEWERBEERTRAG: tradeProvenance }, profile.companyId) }
    const target = kind === 'KST' ? 'STEUERLICHES_ERGEBNIS' : kind === 'EST_BUSINESS' ? 'EINKUENFTE_GEWERBEBETRIEB' : 'FESTZUSTELLENDE_EINKUENFTE'
    if (kind === 'KST' && !kstLiability) throw new TaxDeclarationError(['KSt requires a separately reconciled KST_SCHULD source field.'])
    if (kind === 'EST_BUSINESS' && !estLiability) throw new TaxDeclarationError(['ESt business return requires a separately reconciled EST_SCHULD source field.'])
    const liability = kind === 'KST' ? kstLiability : kind === 'EST_BUSINESS' ? estLiability : undefined
    const liabilityField = kind === 'KST' ? 'KST_SCHULD' : kind === 'EST_BUSINESS' ? 'EST_SCHULD' : undefined
    return registry.prepare(kind, String(year), { [target]: source.amountCents, ...(liability && liabilityField ? { [liabilityField]: liability.amountCents } : {}) }, { [target]: provenance, ...(liability && liabilityField ? { [liabilityField]: [...liability.ledgerEntryIds, ...liability.eBilanzFacts, ...liability.adjustmentIds] } : {}) }, profile.companyId)
  })
}

export function annualReturnDeadline(year: number, profile: AnnualTaxProfile): string {
  // Integration boundary: a fiscal-period/calendar service may replace these statutory defaults.
  const date = profile.adviserExtension ? `${year + 2}-02-${new Date(Date.UTC(year + 2, 2, 0)).getUTCDate()}` : `${year + 1}-07-31`
  return nextBusinessDay(date, germanNationalHolidays(year + 1, year + 2))
}

export interface Assessment { id: string; taxpayerId: string; kind: DeclarationKind; period: string; assessedAmountCents: number; receivedAt: string; documentHash: string; declarationSubmissionId: string }
export function reconcileAssessment(assessment: Assessment, declaration: DeclarationWorkflow) {
  const annual = new Set<DeclarationKind>(['UST_ANNUAL', 'SONDERVORAUSZAHLUNG', 'DAUERFRISTVERLAENGERUNG', 'KST', 'GEWST', 'ZERLEGUNG', 'EST_BUSINESS', 'FESTSTELLUNG'])
  const validPeriod = annual.has(assessment.kind) ? /^\d{4}$/.test(assessment.period) : assessment.kind === 'OSS' ? /^\d{4}-Q[1-4]$/.test(assessment.period) : /^\d{4}-(?:0[1-9]|1[0-2]|Q[1-4])$/.test(assessment.period)
  const received = /^\d{4}-\d{2}-\d{2}$/.test(assessment.receivedAt) ? new Date(`${assessment.receivedAt}T00:00:00Z`) : new Date(Number.NaN)
  if (!assessment.id.trim() || !assessment.taxpayerId.trim() || !assessment.declarationSubmissionId.trim() || !/^[a-f0-9]{64}$/i.test(assessment.documentHash) || !validPeriod || Number.isNaN(received.valueOf()) || received.toISOString().slice(0, 10) !== assessment.receivedAt) throw new TaxDeclarationError(['Assessment reconciliation requires valid identity, document hash, declaration link, period and received date provenance.'])
  const liabilityFields: Partial<Record<DeclarationKind, string>> = { USTVA: 'ZAHLLAST', UST_ANNUAL: 'ZAHLLAST', SONDERVORAUSZAHLUNG: 'ZAHLLAST', OSS: 'STEUER', KST: 'KST_SCHULD', GEWST: 'GEWST_SCHULD', EST_BUSINESS: 'EST_SCHULD' }
  const liabilityField = liabilityFields[assessment.kind]
  if (!liabilityField) throw new TaxDeclarationError([`Assessment reconciliation is not supported for declaration kind ${assessment.kind}.`])
  if (!isExactAcceptedDeclarationWorkflow(declaration) || declaration.submissionId !== assessment.declarationSubmissionId || declaration.dataset.taxpayerId !== assessment.taxpayerId || declaration.dataset.kind !== assessment.kind || declaration.dataset.period !== assessment.period) throw new TaxDeclarationError(['Assessment must reference the exact accepted declaration for the same taxpayer, kind and period.'])
  const acceptedEvent = declaration.events.find(event => event.type === 'submission-accepted')
  if (!acceptedEvent || assessment.receivedAt < acceptedEvent.at.slice(0, 10)) throw new TaxDeclarationError(['Assessment received date cannot predate its exact accepted declaration submission.'])
  const declaredAmountCents = declaration.dataset.fields[liabilityField]
  if (!Number.isSafeInteger(assessment.assessedAmountCents) || !Number.isSafeInteger(declaredAmountCents)) throw new TaxDeclarationError(['Assessment reconciliation requires a canonical declared tax-liability field with safe-integer cent operands.'])
  const difference = BigInt(assessment.assessedAmountCents) - BigInt(declaredAmountCents as number)
  const differenceCents = Number(difference)
  if (!Number.isSafeInteger(differenceCents)) throw new TaxDeclarationError(['Assessment difference exceeds safe integer cents.'])
  return { differenceCents, needsReview: differenceCents !== 0, drilldown: [assessment.id, assessment.declarationSubmissionId] as const }
}
function deepFreeze<T>(value: T): Readonly<T> { if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(deepFreeze) } return value }
function safeAggregate(values: readonly number[]): number | undefined { let sum = 0; for (const value of values) { if (!Number.isSafeInteger(value)) return undefined; sum += value; if (!Number.isSafeInteger(sum)) return undefined } return sum }
function isRealIsoDate(value: string) { if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const date = new Date(`${value}T00:00:00Z`); return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value }
