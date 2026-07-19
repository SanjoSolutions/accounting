import { createHash, randomUUID } from 'node:crypto'
import { isTrustedVatIdValidation, isTrustedVatPosting, normalizeVatId, reconcileVat, type VatIdValidationEvidence, type VatPostingDetail, type VatReconciliation } from './vatEngine'

export type DeclarationKind = 'USTVA' | 'UST_ANNUAL' | 'SONDERVORAUSZAHLUNG' | 'DAUERFRISTVERLAENGERUNG' | 'ZM' | 'OSS' | 'KST' | 'GEWST' | 'ZERLEGUNG' | 'EST_BUSINESS' | 'FESTSTELLUNG'
export type DeclarationState = 'draft' | 'validated' | 'approved' | 'submitting' | 'cancelling' | 'uncertain' | 'accepted' | 'rejected' | 'corrected' | 'cancelled'
export type FilingFrequency = 'monthly' | 'quarterly' | 'exempt'

export interface FilingProfile {
  companyId: string
  frequency: FilingFrequency
  deadlineExtension: boolean
  specialPrepayment: boolean
  zmEnabled: boolean
  ossEnabled: boolean
}
export interface SpecialPrepaymentCredit { amountCents: number; sourceId: string }
export interface FilingPeriod { key: string; from: string; to: string; dueDate: string }
export interface DeclarationDataset {
  kind: DeclarationKind
  period: string
  taxpayerId: string
  formVersion: string
  fields: Readonly<Record<string, number | string | boolean>>
  drilldown: Readonly<Record<string, readonly string[]>>
}
export interface FormMapping {
  kind: DeclarationKind
  version: string
  validFrom: string
  validTo: string
  requiredFields: readonly string[]
  fieldNames: Readonly<Record<string, string>>
}
export interface ValidationResult { valid: boolean; errors: readonly string[]; protocol?: string }
const TRUSTED_GATEWAY = Symbol('trusted-official-tax-gateway')
const trustedGatewayInstances = new WeakSet<object>()
const configuredGatewayInstances = new Map<string, object>()
export interface OfficialTaxGateway {
  readonly [TRUSTED_GATEWAY]: true
  readonly gatewayId: string
  readonly workflowStore: DeclarationWorkflowStore
  validate(dataset: DeclarationDataset): Promise<ValidationResult>
  submit(dataset: DeclarationDataset, idempotencyKey: string): Promise<{ outcome: 'accepted' | 'rejected' | 'uncertain'; receipt?: string; errors?: readonly string[] }>
  correct(targetSubmissionId: string, dataset: DeclarationDataset, idempotencyKey: string): Promise<{ outcome: 'accepted' | 'rejected' | 'uncertain'; receipt?: string; errors?: readonly string[] }>
  cancel(targetSubmissionId: string, idempotencyKey: string): Promise<{ outcome: 'accepted' | 'rejected' | 'uncertain'; receipt?: string; errors?: readonly string[] }>
  recover(idempotencyKey: string): Promise<{ outcome: 'accepted' | 'rejected' | 'uncertain'; receipt?: string; errors?: readonly string[] }>
}
export type TestOfficialTaxGatewayAdapter = Omit<OfficialTaxGateway, typeof TRUSTED_GATEWAY | 'gatewayId' | 'workflowStore'>
export function createConfiguredOfficialTaxGateway(adapter: TestOfficialTaxGatewayAdapter, configurationId: string, workflowStore: DeclarationWorkflowStore): OfficialTaxGateway {
  if (!configurationId.trim() || !trustedWorkflowStores.has(workflowStore)) throw new TaxDeclarationError(['Trusted gateway configuration identity and exact durable workflow store are required.'])
  if (configuredGatewayInstances.has(configurationId)) throw new TaxDeclarationError(['Official gateway configuration identities must resolve to exactly one adapter instance.'])
  const gateway: OfficialTaxGateway = Object.freeze({ gatewayId: configurationId, workflowStore, [TRUSTED_GATEWAY]: true as const, validate: adapter.validate.bind(adapter), submit: adapter.submit.bind(adapter), correct: adapter.correct.bind(adapter), cancel: adapter.cancel.bind(adapter), recover: adapter.recover.bind(adapter) })
  trustedGatewayInstances.add(gateway)
  configuredGatewayInstances.set(configurationId, gateway)
  return gateway
}
export function createTestOfficialTaxGateway(adapter: TestOfficialTaxGatewayAdapter): OfficialTaxGateway {
  if (process.env.NODE_ENV !== 'test') throw new TaxDeclarationError(['The in-memory official gateway factory is test-only; configure a trusted production adapter.'])
  return createConfiguredOfficialTaxGateway(adapter, `vitest-in-memory-gateway-${randomUUID()}`, createTestDeclarationWorkflowStore())
}
export interface DeclarationEvent { id: string; at: string; type: string; actor?: string; payload: Readonly<Record<string, unknown>> }

export class TaxDeclarationError extends Error { constructor(readonly issues: readonly string[]) { super(issues.join(' ')); this.name = 'TaxDeclarationError' } }
const OFFICIAL_GATEWAY_CAPABILITY = Symbol('official-tax-gateway-result')
const WORKFLOW_STORE_CAPABILITY = Symbol('declaration-workflow-store')

export class FormRegistry {
  readonly mappings: readonly FormMapping[]
  constructor(mappings: readonly FormMapping[]) {
    const issues: string[] = []
    for (const mapping of mappings) {
      if (!mapping.version.trim() || !/^\d{4}$/.test(mapping.validFrom) || !/^\d{4}$/.test(mapping.validTo) || mapping.validFrom > mapping.validTo || !mapping.requiredFields.length || mapping.requiredFields.some(field => !field.trim()) || new Set(mapping.requiredFields).size !== mapping.requiredFields.length) issues.push(`Form mapping ${mapping.kind} ${mapping.version || '(blank)'} has invalid canonical version, range or required fields.`)
      if (mappings.some(other => other !== mapping && other.kind === mapping.kind && mapping.validFrom <= other.validTo && other.validFrom <= mapping.validTo)) issues.push(`Form mappings for ${mapping.kind} have overlapping validity ranges.`)
    }
    if (issues.length) throw new TaxDeclarationError([...new Set(issues)])
    this.mappings = Object.freeze(mappings.map(mapping => Object.freeze({ ...mapping, requiredFields: Object.freeze([...mapping.requiredFields]), fieldNames: Object.freeze({ ...mapping.fieldNames }) })))
    Object.freeze(this)
  }
  resolve(kind: DeclarationKind, period: string): FormMapping {
    const annual = new Set<DeclarationKind>(['UST_ANNUAL', 'SONDERVORAUSZAHLUNG', 'DAUERFRISTVERLAENGERUNG', 'KST', 'GEWST', 'ZERLEGUNG', 'EST_BUSINESS', 'FESTSTELLUNG'])
    const valid = annual.has(kind) ? /^\d{4}$/.test(period) : kind === 'OSS' ? /^\d{4}-Q[1-4]$/.test(period) : /^\d{4}-(?:0[1-9]|1[0-2]|Q[1-4])$/.test(period)
    if (!valid) throw new TaxDeclarationError([`Invalid ${kind} filing period ${period}.`])
    const year = period.slice(0, 4)
    const mapping = year && this.mappings.find(candidate => candidate.kind === kind && candidate.validFrom <= year && year <= candidate.validTo)
    if (!mapping) throw new TaxDeclarationError([`Unsupported ${kind} period ${period}; no official form mapping is installed.`])
    return mapping
  }
  prepare(kind: DeclarationKind, period: string, fields: Record<string, number | string | boolean>, drilldown: Record<string, readonly string[]> = {}, taxpayerId = ''): DeclarationDataset {
    const mapping = this.resolve(kind, period)
    const issues = mapping.requiredFields.filter(field => !Object.hasOwn(fields, field) || fields[field] === undefined).map(field => `Required field ${field} is missing.`)
    if (Object.values(fields).some(value => value === undefined) || Object.values(drilldown).some(ids => !Array.isArray(ids) || ids.some(id => typeof id !== 'string'))) issues.push('Declaration fields and drilldown must not contain undefined or malformed values.')
    if (issues.length) throw new TaxDeclarationError(issues)
    if (!taxpayerId.trim()) throw new TaxDeclarationError(['Taxpayer identity is required.'])
    return deepFreeze({ kind, period, taxpayerId, formVersion: mapping.version, fields: { ...fields }, drilldown: { ...drilldown } })
  }
}

export function deriveVatPeriods(year: number, profile: FilingProfile, holidays: ReadonlySet<string> = germanNationalHolidays(year, year + 1)): FilingPeriod[] {
  assertFilingFrequency(profile.frequency)
  if (!Number.isSafeInteger(year) || year < 1000 || year > 9999) throw new TaxDeclarationError(['VAT periods require a safe four-digit calendar year.'])
  if (profile.frequency === 'exempt') return []
  const months = profile.frequency === 'monthly' ? Array.from({ length: 12 }, (_, index) => index + 1) : [3, 6, 9, 12]
  return months.map(endMonth => {
    const startMonth = profile.frequency === 'monthly' ? endMonth : endMonth - 2
    const key = profile.frequency === 'monthly' ? `${year}-${pad(endMonth)}` : `${year}-Q${endMonth / 3}`
    const nextMonth = endMonth === 12 ? 1 : endMonth + 1
    const nextYear = endMonth === 12 ? year + 1 : year
    const dueMonth = profile.deadlineExtension ? (nextMonth === 12 ? 1 : nextMonth + 1) : nextMonth
    const dueYear = profile.deadlineExtension && nextMonth === 12 ? nextYear + 1 : nextYear
    return { key, from: `${year}-${pad(startMonth)}-01`, to: `${year}-${pad(endMonth)}-${daysInMonth(year, endMonth)}`, dueDate: nextBusinessDay(`${dueYear}-${pad(dueMonth)}-10`, holidays) }
  })
}
export function deriveOssPeriods(year: number, enabled: boolean, _holidays: ReadonlySet<string> = germanNationalHolidays(year, year + 1)): FilingPeriod[] {
  if (!enabled) return []
  if (!Number.isSafeInteger(year) || year < 1000 || year > 9999) throw new TaxDeclarationError(['OSS periods require a safe four-digit calendar year.'])
  return [3, 6, 9, 12].map(endMonth => ({ key: `${year}-Q${endMonth / 3}`, from: `${year}-${pad(endMonth - 2)}-01`, to: `${year}-${pad(endMonth)}-${daysInMonth(year, endMonth)}`, dueDate: `${endMonth === 12 ? year + 1 : year}-${pad(endMonth === 12 ? 1 : endMonth + 1)}-${daysInMonth(endMonth === 12 ? year + 1 : year, endMonth === 12 ? 1 : endMonth + 1)}` }))
}

export function deriveVatDatasets(period: FilingPeriod, profile: FilingProfile, details: readonly VatPostingDetail[], reconciliation: VatReconciliation, registry: FormRegistry, ossPeriod?: FilingPeriod, ossReconciliation?: VatReconciliation, zmPeriodInput?: FilingPeriod | readonly FilingPeriod[], specialPrepayment?: SpecialPrepaymentCredit): DeclarationDataset[] {
  assertCanonicalFilingPeriod(period)
  assertFilingFrequency(profile.frequency)
  if (profile.specialPrepayment && !profile.deadlineExtension) throw new TaxDeclarationError(['Special prepayment requires an active deadline extension.'])
  if (profile.frequency === 'exempt') throw new TaxDeclarationError(['VAT-exempt profiles cannot produce a UStVA dataset.'])
  if (reconciliation.toleranceCents !== 0) throw new TaxDeclarationError(['VAT filing requires exact zero-tolerance ledger reconciliation.'])
  const expectedCadence = profile.frequency === 'monthly' ? /^\d{4}-(?:0[1-9]|1[0-2])$/ : /^\d{4}-Q[1-4]$/
  if (!expectedCadence.test(period.key)) throw new TaxDeclarationError([`UStVA period ${period.key} does not match the ${profile.frequency} filing cadence.`])
  const periodDetails = details.filter(detail => period.from <= detail.taxPoint && detail.taxPoint <= period.to)
  if (reconciliation.ownerId !== profile.companyId || periodDetails.some(detail => detail.ownerId !== profile.companyId)) throw new TaxDeclarationError(['VAT reconciliation and postings must match the filing profile taxpayer.'])
  const verified = reconcileVat(periodDetails, reconciliation.ledger, reconciliation.toleranceCents, profile.companyId)
  if (!verified.ok) throw new TaxDeclarationError(verified.discrepancies)
  const fields: Record<string, number> = {}
  const drilldown: Record<string, string[]> = {}
  for (const box of verified.boxes) { fields[`KZ${box.box}`] = box.amountCents; drilldown[`KZ${box.box}`] = [...box.entryIds, ...box.documentIds] }
  const decemberSpecialPrepayment = profile.frequency === 'monthly' && /-12$/.test(period.key) && profile.specialPrepayment
  if (decemberSpecialPrepayment && (!specialPrepayment || !Number.isSafeInteger(specialPrepayment.amountCents) || specialPrepayment.amountCents < 0 || !specialPrepayment.sourceId.trim())) throw new TaxDeclarationError(['December UStVA requires the actual non-negative safe-integer Sondervorauszahlung with source provenance.'])
  const payableComponents = periodDetails.filter(detail => detail.case !== 'oss-sale').flatMap(detail => [detail.outputTaxCents, -detail.inputTaxCents])
  if (decemberSpecialPrepayment) { fields.KZ39 = specialPrepayment!.amountCents; drilldown.KZ39 = [specialPrepayment!.sourceId]; payableComponents.push(-specialPrepayment!.amountCents) }
  fields.ZAHLLAST = safeSum(payableComponents, 'VAT payable')
  fields.KZ83 = fields.ZAHLLAST; drilldown.KZ83 = [...periodDetails.filter(detail => detail.case !== 'oss-sale').map(detail => detail.sourceId), ...(decemberSpecialPrepayment ? [specialPrepayment!.sourceId] : [])]
  const datasets = [registry.prepare('USTVA', period.key, fields, drilldown, profile.companyId)]
  const zmCandidates = details.filter(detail => ['intra-eu-supply', 'intra-eu-service'].includes(detail.case))
  if (zmCandidates.some(detail => !isTrustedVatPosting(detail))) throw new TaxDeclarationError(['ZM periods require exact trusted calculated postings across their complete independent period.'])
  if (zmCandidates.some(detail => detail.ownerId !== profile.companyId)) throw new TaxDeclarationError(['Every independent-period ZM posting must belong to the filing-profile taxpayer.'])
  const allEligibleZm = zmCandidates.filter(detail => detail.direction !== 'purchase' && detail.customerType === 'business' && detail.customerVatId && detail.customerCountry && detail.supplyKind && isTrustedVatIdValidation(detail.customerVatIdValidation, detail.customerVatId, detail.customerCountry, detail.supplyKind))
  if (allEligibleZm.length && !profile.zmEnabled) throw new TaxDeclarationError(['Eligible intra-EU supplies require the ZM filing obligation to be enabled.'])
  if (profile.zmEnabled) {
    if (allEligibleZm.length && !zmPeriodInput) throw new TaxDeclarationError(['Eligible intra-EU supplies require one or more separate canonical ZM filing periods.'])
    const zmPeriods = (zmPeriodInput ? Array.isArray(zmPeriodInput) ? [...zmPeriodInput] : [zmPeriodInput] : []).sort((left, right) => left.from.localeCompare(right.from))
    for (const zmPeriod of zmPeriods) { assertCanonicalFilingPeriod(zmPeriod); if (!/^\d{4}-(?:0[1-9]|1[0-2]|Q[1-4])$/.test(zmPeriod.key)) throw new TaxDeclarationError(['ZM requires explicit monthly or quarterly filing periods.']) }
    if (new Set(zmPeriods.map(item => item.key)).size !== zmPeriods.length || allEligibleZm.some(detail => zmPeriods.filter(item => item.from <= detail.taxPoint && detail.taxPoint <= item.to).length !== 1)) throw new TaxDeclarationError(['The selected ZM periods must uniquely account for every supplied eligible intra-EU posting.'])
    for (const zmPeriod of zmPeriods) {
      const eligible = allEligibleZm.filter(detail => zmPeriod.from <= detail.taxPoint && detail.taxPoint <= zmPeriod.to)
      if (new Set(eligible.map(detail => detail.sourceId)).size !== eligible.length) throw new TaxDeclarationError(['Each independent ZM period requires unique trusted posting source IDs.'])
      const customerTotals = new Map<string, { amountCents: bigint; sourceIds: string[]; validationEvidence: VatIdValidationEvidence }>()
      for (const detail of eligible) { const customerVatId = normalizeVatId(detail.customerVatId!); const key = `${customerVatId}:${detail.supplyKind}`; const current = customerTotals.get(key) ?? { amountCents: BigInt(0), sourceIds: [], validationEvidence: detail.customerVatIdValidation! }; current.amountCents += BigInt(detail.netBaseCents); current.sourceIds.push(detail.sourceId); customerTotals.set(key, current) }
      const entries = [...customerTotals].map(([key, value]) => { const [customerVatId, supplyKind] = key.split(':') as [string, 'goods' | 'services']; return { customerVatId, validationEvidence: value.validationEvidence, supplyKind, amountCents: safeBigIntCents(value.amountCents, `ZM customer ${customerVatId}`), sourceIds: value.sourceIds } })
      if (entries.length) { validateZmEntries(entries); datasets.push(registry.prepare('ZM', zmPeriod.key, { SUMME: safeSum(entries.map(item => item.amountCents), 'ZM total'), USTID_OK: true, MELDUNGEN: JSON.stringify(entries.map(({ customerVatId, supplyKind, amountCents }) => ({ customerVatId, supplyKind, amountCents }))) }, { SUMME: eligible.map(item => item.sourceId) }, profile.companyId)) }
    }
  }
  const allOssDetails = details.filter(detail => detail.case === 'oss-sale')
  if (allOssDetails.length && !profile.ossEnabled) throw new TaxDeclarationError(['OSS sales require the OSS filing obligation to be enabled.'])
  if (profile.ossEnabled && (!ossPeriod || !ossReconciliation)) throw new TaxDeclarationError(['Enabled OSS filing requires a separate canonical quarterly OSS period and reconciliation, including nil quarters.'])
  if (profile.ossEnabled && ossPeriod && ossReconciliation) {
    if (ossReconciliation.toleranceCents !== 0) throw new TaxDeclarationError(['OSS filing requires exact zero-tolerance ledger reconciliation.'])
    assertCanonicalFilingPeriod(ossPeriod)
    if (!/^\d{4}-Q[1-4]$/.test(ossPeriod.key)) throw new TaxDeclarationError(['OSS requires a separate quarterly filing period.'])
    if (ossPeriod.from > period.from || ossPeriod.to < period.to || allOssDetails.some(detail => detail.taxPoint < ossPeriod.from || detail.taxPoint > ossPeriod.to)) throw new TaxDeclarationError(['The selected OSS quarter must cover the primary filing interval and every supplied OSS sale.'])
    if (ossReconciliation.ownerId !== profile.companyId) throw new TaxDeclarationError(['OSS requires a separate quarterly reconciliation for the filing-profile taxpayer.'])
    const ossPeriodDetails = details.filter(detail => ossPeriod.from <= detail.taxPoint && detail.taxPoint <= ossPeriod.to)
    const verifiedOss = reconcileVat(ossPeriodDetails, ossReconciliation.ledger, ossReconciliation.toleranceCents, profile.companyId)
    if (!verifiedOss.ok) throw new TaxDeclarationError(verifiedOss.discrepancies)
    const eligible = ossPeriodDetails.filter(detail => detail.case === 'oss-sale' && detail.direction !== 'purchase' && detail.customerType === 'consumer' && detail.customerCountry)
    const groupedBases = new Map<string, { amountCents: bigint; taxCents: bigint; sourceIds: string[] }>()
    const grouped: Record<string, number> = {}
    const ossDrilldown: Record<string, string[]> = {}
    for (const detail of eligible) { const key = `LAND_${detail.customerCountry}_SATZ_${detail.rateBasisPoints}`; const current = groupedBases.get(key) ?? { amountCents: BigInt(0), taxCents: BigInt(0), sourceIds: [] }; current.amountCents += BigInt(detail.netBaseCents); current.taxCents += BigInt(detail.outputTaxCents); current.sourceIds.push(detail.sourceId); groupedBases.set(key, current) }
    const taxAmounts: number[] = []
    for (const [key, value] of groupedBases) { const base = safeBigIntCents(value.amountCents, `OSS field ${key}`); const tax = safeBigIntCents(value.taxCents, `OSS tax ${key}`); grouped[key] = base; grouped[`${key}_STEUER`] = tax; ossDrilldown[key] = [...value.sourceIds]; ossDrilldown[`${key}_STEUER`] = [...value.sourceIds]; taxAmounts.push(tax) }
    datasets.push(registry.prepare('OSS', ossPeriod.key, { UMSATZ: safeSum(eligible.map(item => item.netBaseCents), 'OSS total'), STEUER: safeSum(taxAmounts, 'OSS tax total'), ...grouped }, ossDrilldown, profile.companyId))
  }
  return datasets
}

export function annualVatDataset(year: number, details: readonly VatPostingDetail[], reconciliation: VatReconciliation, registry: FormRegistry, taxpayerId: string): DeclarationDataset {
  if (reconciliation.toleranceCents !== 0) throw new TaxDeclarationError(['Annual VAT filing requires exact zero-tolerance ledger reconciliation.'])
  if (!reconciliation.ok) throw new TaxDeclarationError(reconciliation.discrepancies)
  if (reconciliation.ownerId !== taxpayerId || details.some(detail => detail.ownerId !== taxpayerId)) throw new TaxDeclarationError(['Annual VAT reconciliation and postings must match the filing taxpayer.'])
  if (details.some(detail => !detail.taxPoint.startsWith(`${year}-`))) throw new TaxDeclarationError(['Annual VAT details must belong to the requested year.'])
  const verified = reconcileVat(details, reconciliation.ledger, reconciliation.toleranceCents, taxpayerId)
  if (!verified.ok) throw new TaxDeclarationError(verified.discrepancies)
  const fields = Object.fromEntries(verified.boxes.map(box => [`KZ${box.box}`, box.amountCents]))
  const domesticPayable = safeSum(details.filter(detail => detail.case !== 'oss-sale').flatMap(detail => [detail.outputTaxCents, -detail.inputTaxCents]), 'annual VAT payable')
  return registry.prepare('UST_ANNUAL', String(year), { ...fields, ZAHLLAST: domesticPayable }, Object.fromEntries(verified.boxes.map(box => [`KZ${box.box}`, [...box.entryIds, ...box.documentIds]])), taxpayerId)
}

export function extensionDatasets(year: number, profile: FilingProfile, registry: FormRegistry, priorYearAdvancePaymentsCents?: number): DeclarationDataset[] {
  assertFilingFrequency(profile.frequency)
  if (profile.specialPrepayment && !profile.deadlineExtension) throw new TaxDeclarationError(['Special prepayment requires an active deadline extension.'])
  if (!profile.deadlineExtension) return []
  if (profile.frequency === 'exempt') {
    if (profile.specialPrepayment) throw new TaxDeclarationError(['VAT-exempt profiles cannot request a deadline extension or special prepayment.'])
    return []
  }
  const result = [registry.prepare('DAUERFRISTVERLAENGERUNG', String(year), { ZAHLLAST: 0 }, {}, profile.companyId)]
  if (profile.specialPrepayment) {
    if (profile.frequency !== 'monthly') throw new TaxDeclarationError(['Special prepayment is only applicable to monthly VAT filers.'])
    if (!Number.isSafeInteger(priorYearAdvancePaymentsCents)) throw new TaxDeclarationError(['Prior-year VAT advance payments must be safe-integer cents for the special prepayment.'])
    const specialPrepaymentCents = priorYearAdvancePaymentsCents! <= 0 ? 0 : Number(BigInt(priorYearAdvancePaymentsCents!) / BigInt(1_100) * BigInt(100))
    if (!Number.isSafeInteger(specialPrepaymentCents)) throw new TaxDeclarationError(['Calculated special prepayment exceeds safe integer cents.'])
    result.push(registry.prepare('SONDERVORAUSZAHLUNG', String(year), { ZAHLLAST: specialPrepaymentCents }, {}, profile.companyId))
  }
  return result
}

export interface ZmEntry { customerVatId: string; validationEvidence: VatIdValidationEvidence; supplyKind: 'goods' | 'services'; amountCents: number; sourceIds: readonly string[] }
export function validateZmEntries(entries: readonly ZmEntry[]): void {
  const issues = entries.flatMap((entry, index) => [
    ...(!isSupportedEuVatId(entry.customerVatId, entry.supplyKind) ? [`ZM entry ${index + 1} has an invalid non-German EU VAT ID for its supply kind.`] : []),
    ...(!isTrustedVatIdValidation(entry.validationEvidence, entry.customerVatId, entry.validationEvidence.countryCode, entry.supplyKind) ? [`ZM entry ${index + 1} VAT ID has not been authoritatively validated.`] : []),
    ...(!Number.isSafeInteger(entry.amountCents) ? [`ZM entry ${index + 1} has an invalid amount.`] : []),
    ...(!entry.sourceIds.length || entry.sourceIds.some(id => !id.trim()) || new Set(entry.sourceIds).size !== entry.sourceIds.length ? [`ZM entry ${index + 1} requires unique nonblank drilldown identifiers.`] : []),
  ])
  if (issues.length) throw new TaxDeclarationError(issues)
}

export function validateGermanVatId(vatId: string): boolean { return /^DE\d{9}$/.test(vatId.replace(/[\s.-]/g, '').toUpperCase()) }
function isSupportedEuVatId(value: string, supplyKind: 'goods' | 'services') { const vat = value.replace(/[\s.-]/g, '').toUpperCase(); const prefixes = new Set(['AT','BE','BG','CY','CZ','DK','EE','EL','ES','FI','FR','HR','HU','IE','IT','LT','LU','LV','MT','NL','PL','PT','RO','SE','SI','SK']); const prefix = vat.slice(0, 2); return (prefixes.has(prefix) || (prefix === 'XI' && supplyKind === 'goods')) && /^[A-Z]{2}[A-Z0-9]{2,12}$/.test(vat) }

const officiallyAcceptedWorkflows = new WeakSet<object>()
const actionableAcceptedWorkflows = new WeakSet<object>()
const internallyConstructedWorkflows = new WeakSet<object>()
type DurableDeclarationLifecycle = 'accepted' | 'cancelling' | 'corrected' | 'cancelled'
const durableDeclarationLifecycles = new Map<string, DurableDeclarationLifecycle>()
function declarationLifecycleKey(workflow: Pick<DeclarationWorkflow, 'workflowStoreId' | 'submissionId'>) { return `${workflow.workflowStoreId ?? ''}\u0000${workflow.submissionId}` }
function setDeclarationLifecycle(workflow: Pick<DeclarationWorkflow, 'workflowStoreId' | 'submissionId'>, state: DurableDeclarationLifecycle) { durableDeclarationLifecycles.set(declarationLifecycleKey(workflow), state) }
function hasDeclarationLifecycle(workflow: Pick<DeclarationWorkflow, 'workflowStoreId' | 'submissionId'>, state: DurableDeclarationLifecycle) { return durableDeclarationLifecycles.get(declarationLifecycleKey(workflow)) === state }
export class DeclarationWorkflow {
  readonly state: DeclarationState
  readonly events: readonly DeclarationEvent[]
  readonly dataset: DeclarationDataset
  readonly idempotencyKey?: string
  readonly receipt?: string
  readonly correctsId?: string
  readonly submissionId: string
  readonly gatewayId?: string
  readonly workflowStoreId?: string
  private constructor(args: { dataset: DeclarationDataset; state?: DeclarationState; events?: readonly DeclarationEvent[]; idempotencyKey?: string; receipt?: string; correctsId?: string; submissionId?: string; gatewayId?: string; workflowStoreId?: string }) {
    this.dataset = cloneDataset(args.dataset); this.state = args.state ?? 'draft'; this.events = deepFreeze((args.events ?? []).map(item => ({ ...item, payload: { ...item.payload } }))) as readonly DeclarationEvent[]; this.idempotencyKey = args.idempotencyKey; this.receipt = args.receipt; this.correctsId = args.correctsId; this.submissionId = args.submissionId ?? randomUUID(); this.gatewayId = args.gatewayId; this.workflowStoreId = args.workflowStoreId
    internallyConstructedWorkflows.add(this)
    Object.freeze(this)
  }
  static create(dataset: DeclarationDataset, now = new Date().toISOString()) { return new DeclarationWorkflow({ dataset, events: [event(now, 'created', { datasetHash: datasetHash(dataset) })] }) }
  static restorePersisted(args: { dataset: DeclarationDataset; state: 'submitting' | 'cancelling' | 'uncertain' | 'accepted' | 'rejected' | 'corrected' | 'cancelled'; events: readonly DeclarationEvent[]; idempotencyKey: string; receipt?: string; correctsId?: string; submissionId: string; gatewayId: string; workflowStoreId: string }, capability: symbol) { if (capability !== WORKFLOW_STORE_CAPABILITY) throw new TaxDeclarationError(['Persisted workflows can only be restored by the configured durable store.']); return new DeclarationWorkflow(args) }
  validated(result: ValidationResult, capability: symbol, gatewayId: string, workflowStoreId: string, now = new Date().toISOString()): DeclarationWorkflow {
    this.requireInternal()
    if (capability !== OFFICIAL_GATEWAY_CAPABILITY) throw new TaxDeclarationError(['Official validation transitions can only be created by the configured gateway.'])
    this.requireState('draft', 'rejected')
    if (!result.valid || result.errors.length) throw new TaxDeclarationError(result.errors.length ? result.errors : ['Official validation did not approve the declaration.'])
    return this.transition('validated', now, 'official-validation-passed', { protocol: result.protocol ?? '' }, undefined, { gatewayId, workflowStoreId })
  }
  approved(actor: string, now = new Date().toISOString()): DeclarationWorkflow {
    this.requireInternal()
    this.requireState('validated')
    if (!actor.trim()) throw new TaxDeclarationError(['Explicit approving actor is required.'])
    return this.transition('approved', now, 'approved', {}, actor)
  }
  beginSubmission(now = new Date().toISOString()): DeclarationWorkflow {
    this.requireInternal()
    if (this.state === 'submitting' || this.state === 'uncertain' || this.state === 'accepted') return this
    this.requireState('approved')
    const key = this.idempotencyKey ?? createHash('sha256').update(`${this.submissionId}:${datasetHash(this.dataset)}`).digest('hex')
    return this.transition('submitting', now, 'submission-started', { idempotencyKey: key }, undefined, { idempotencyKey: key })
  }
  submitted(outcome: 'accepted' | 'rejected' | 'uncertain', receipt: string | undefined, errors: readonly string[], capability: symbol, now = new Date().toISOString()): DeclarationWorkflow {
    this.requireInternal()
    if (capability !== OFFICIAL_GATEWAY_CAPABILITY) throw new TaxDeclarationError(['Submission outcomes can only be created by the configured gateway.'])
    this.requireState('submitting', 'uncertain')
    if (outcome === 'accepted' && !receipt?.trim()) throw new TaxDeclarationError(['A nonblank immutable official receipt is required for accepted submissions.'])
    const transitioned = this.transition(outcome, now, `submission-${outcome}`, { receipt: receipt ?? '', errors: [...errors] }, undefined, { receipt: receipt ?? this.receipt })
    if (outcome === 'accepted') { setDeclarationLifecycle(transitioned, 'accepted'); officiallyAcceptedWorkflows.add(transitioned); if (!transitioned.correctsId) actionableAcceptedWorkflows.add(transitioned) }
    return transitioned
  }
  cancelled(actor: string, receipt: string, idempotencyKey: string, capability: symbol, now = new Date().toISOString()): DeclarationWorkflow {
    this.requireInternal()
    if (capability !== OFFICIAL_GATEWAY_CAPABILITY) throw new TaxDeclarationError(['Cancellation outcomes can only be created by the configured gateway.'])
    this.requireState('cancelling', 'uncertain')
    if (!actor.trim()) throw new TaxDeclarationError(['Explicit cancelling actor is required.'])
    if (!receipt.trim()) throw new TaxDeclarationError(['A nonblank official cancellation receipt is required.'])
    officiallyAcceptedWorkflows.delete(this); actionableAcceptedWorkflows.delete(this)
    const transitioned = this.transition('cancelled', now, 'cancellation-accepted', { receipt }, actor, { receipt, idempotencyKey }); setDeclarationLifecycle(transitioned, 'cancelled'); return transitioned
  }
  beginCancellation(actor: string, idempotencyKey: string, now = new Date().toISOString()): DeclarationWorkflow { this.requireInternal(); this.requireState('accepted'); if (!officiallyAcceptedWorkflows.has(this) || !actionableAcceptedWorkflows.has(this) || !hasDeclarationLifecycle(this, 'accepted') || !actor.trim() || !idempotencyKey.trim()) throw new TaxDeclarationError(['Cancellation requires the exact actionable officially accepted workflow, actor and idempotency key.']); officiallyAcceptedWorkflows.delete(this); actionableAcceptedWorkflows.delete(this); const cancelling = this.transition('cancelling', now, 'cancellation-started', { cancellationActor: actor, idempotencyKey }, actor, { idempotencyKey }); setDeclarationLifecycle(cancelling, 'cancelling'); officiallyAcceptedWorkflows.add(cancelling); actionableAcceptedWorkflows.add(cancelling); return cancelling }
  cancellationOutcome(outcome: 'accepted' | 'rejected' | 'uncertain', actor: string, receipt: string | undefined, errors: readonly string[], idempotencyKey: string, capability: symbol, now = new Date().toISOString()): DeclarationWorkflow {
    this.requireInternal()
    if (capability !== OFFICIAL_GATEWAY_CAPABILITY) throw new TaxDeclarationError(['Cancellation outcomes can only be created by the configured gateway.'])
    this.requireState('cancelling', 'uncertain')
    if (outcome === 'accepted') { if (!receipt?.trim()) throw new TaxDeclarationError(['A nonblank official cancellation receipt is required.']); return this.cancelled(actor, receipt, idempotencyKey, capability, now) }
    const state: DeclarationState = outcome === 'uncertain' ? 'uncertain' : 'accepted'
    const transitioned = this.transition(state, now, `cancellation-${outcome}`, { receipt: receipt ?? '', errors: [...errors], cancellationActor: actor }, actor, { idempotencyKey }); setDeclarationLifecycle(transitioned, outcome === 'uncertain' ? 'cancelling' : 'accepted')
    const active = officiallyAcceptedWorkflows.has(this); const actionable = actionableAcceptedWorkflows.has(this); officiallyAcceptedWorkflows.delete(this); actionableAcceptedWorkflows.delete(this); if (active) officiallyAcceptedWorkflows.add(transitioned); if (actionable) actionableAcceptedWorkflows.add(transitioned)
    return transitioned
  }
  correction(dataset: DeclarationDataset, now = new Date().toISOString()): { original: DeclarationWorkflow; correction: DeclarationWorkflow } {
    this.requireInternal()
    this.requireState('accepted')
    if (!officiallyAcceptedWorkflows.has(this) || !actionableAcceptedWorkflows.has(this) || !hasDeclarationLifecycle(this, 'accepted')) throw new TaxDeclarationError(['Corrections require the exact actionable officially accepted workflow.'])
    if (dataset.kind !== this.dataset.kind || dataset.period !== this.dataset.period || dataset.taxpayerId !== this.dataset.taxpayerId) throw new TaxDeclarationError(['A correction must have the same kind, period and taxpayer as the accepted declaration.'])
    const correction = new DeclarationWorkflow({ dataset, correctsId: this.submissionId, gatewayId: this.gatewayId, workflowStoreId: this.workflowStoreId, events: [event(now, 'created-as-correction', { correctsId: this.submissionId, originalReceipt: this.receipt ?? '', datasetHash: datasetHash(dataset) }, undefined, this.events.at(-1)?.at)] })
    return { original: this, correction }
  }
  finalizedByCorrection(correction: DeclarationWorkflow, capability: symbol, now = new Date().toISOString()): DeclarationWorkflow {
    this.requireInternal()
    if (capability !== OFFICIAL_GATEWAY_CAPABILITY) throw new TaxDeclarationError(['Correction outcomes can only be finalized by the configured gateway workflow.'])
    if (!officiallyAcceptedWorkflows.has(this) || !officiallyAcceptedWorkflows.has(correction)) throw new TaxDeclarationError(['Correction finalization requires the exact internally tracked workflows accepted by the official gateway.'])
    if (this.state !== 'accepted' || correction.state !== 'accepted' || correction.correctsId !== this.submissionId) throw new TaxDeclarationError(['Only an officially accepted linked correction can finalize the original declaration.'])
    return this.transition('corrected', now, 'correction-accepted', { correctionSubmissionId: correction.submissionId, correctionReceipt: correction.receipt ?? '' })
  }
  private requireInternal() { if (!internallyConstructedWorkflows.has(this)) throw new TaxDeclarationError(['Declaration transitions require the exact internally constructed workflow instance.']) }
  private requireState(...states: DeclarationState[]) { if (!states.includes(this.state)) throw new TaxDeclarationError([`Cannot perform operation while declaration is ${this.state}.`]) }
  private transition(state: DeclarationState, now: string, type: string, payload: Record<string, unknown>, actor?: string, changes: { idempotencyKey?: string; receipt?: string; gatewayId?: string; workflowStoreId?: string } = {}) {
    return new DeclarationWorkflow({ dataset: this.dataset, state, events: [...this.events, event(now, type, payload, actor, this.events.at(-1)?.at)], idempotencyKey: changes.idempotencyKey ?? this.idempotencyKey, receipt: changes.receipt ?? this.receipt, correctsId: this.correctsId, submissionId: this.submissionId, gatewayId: changes.gatewayId ?? this.gatewayId, workflowStoreId: changes.workflowStoreId ?? this.workflowStoreId })
  }
}

export interface PersistedDeclarationWorkflow {
  version: 1
  revision: number
  snapshot: { dataset: DeclarationDataset; state: 'submitting' | 'cancelling' | 'uncertain' | 'accepted' | 'rejected' | 'corrected' | 'cancelled'; events: readonly DeclarationEvent[]; idempotencyKey: string; receipt?: string; correctsId?: string; submissionId: string; gatewayId: string; workflowStoreId: string }
  authenticationTag: string
}
export interface DeclarationWorkflowPersistence {
  save(record: PersistedDeclarationWorkflow): boolean | Promise<boolean>
  saveWithActionReservation(record: PersistedDeclarationWorkflow, targetSubmissionId: string, actionId: string): boolean | Promise<boolean>
  saveWithActionRelease(record: PersistedDeclarationWorkflow, targetSubmissionId: string, actionId: string): boolean | Promise<boolean>
  load(submissionId: string): unknown | Promise<unknown>
  loadRevision(submissionId: string): number | undefined | Promise<number | undefined>
  remove(submissionId: string): void | Promise<void>
  removeWithActionRelease(submissionId: string, targetSubmissionId: string, actionId: string): void | Promise<void>
  reserveAction(submissionId: string, actionId: string): boolean | Promise<boolean>
  releaseAction(submissionId: string, actionId: string): void | Promise<void>
}
export interface DeclarationWorkflowAuthenticator { configurationId: string; authenticate(payload: string): string | Promise<string>; verify(payload: string, authenticationTag: string): boolean | Promise<boolean> }
const trustedWorkflowStores = new WeakSet<object>()
const configuredWorkflowStoreInstances = new Map<string, object>()
const trustedWorkflowAuthenticators = new WeakSet<object>()
export function createConfiguredDeclarationWorkflowAuthenticator(adapter: Omit<DeclarationWorkflowAuthenticator, 'configurationId'>, configurationId: string): DeclarationWorkflowAuthenticator { if (!configurationId.trim() || typeof adapter.authenticate !== 'function' || typeof adapter.verify !== 'function') throw new TaxDeclarationError(['A configured workflow MAC or signature adapter is required.']); const authenticator = Object.freeze({ configurationId, authenticate: adapter.authenticate.bind(adapter), verify: adapter.verify.bind(adapter) }); trustedWorkflowAuthenticators.add(authenticator); return authenticator }
export class DeclarationWorkflowStore {
  readonly configurationId: string
  private constructor(private readonly persistence: DeclarationWorkflowPersistence, private readonly authenticator: DeclarationWorkflowAuthenticator, configurationId: string) { this.configurationId = configurationId; trustedWorkflowStores.add(this); configuredWorkflowStoreInstances.set(configurationId, this); Object.freeze(this) }
  static configured(persistence: DeclarationWorkflowPersistence, authenticator: DeclarationWorkflowAuthenticator, configurationId: string) { if (!configurationId.trim() || typeof persistence.save !== 'function' || typeof persistence.saveWithActionReservation !== 'function' || typeof persistence.saveWithActionRelease !== 'function' || typeof persistence.load !== 'function' || typeof persistence.loadRevision !== 'function' || typeof persistence.remove !== 'function' || typeof persistence.removeWithActionRelease !== 'function' || typeof persistence.reserveAction !== 'function' || typeof persistence.releaseAction !== 'function' || !trustedWorkflowAuthenticators.has(authenticator)) throw new TaxDeclarationError(['A configured durable declaration-workflow persistence adapter with atomic monotonic revisions, action reservation and release plus exact external authenticator is required.']); if (configuredWorkflowStoreInstances.has(configurationId)) throw new TaxDeclarationError(['Workflow-store configuration identities must resolve to exactly one durable store instance.']); return new DeclarationWorkflowStore(persistence, authenticator, configurationId) }
  async persist(workflow: DeclarationWorkflow) {
    if (!await this.persistence.save(await this.recordFor(workflow))) throw new TaxDeclarationError(['Durable workflow persistence rejected a stale or conflicting revision.'])
  }
  async persistWithActionReservation(workflow: DeclarationWorkflow, targetSubmissionId: string, actionId: string) { if (!targetSubmissionId.trim() || !actionId.trim() || !await this.persistence.saveWithActionReservation(await this.recordFor(workflow), targetSubmissionId, actionId)) throw new TaxDeclarationError(['The active declaration already has a conflicting official action or is no longer accepted.']) }
  async persistWithActionRelease(workflow: DeclarationWorkflow, targetSubmissionId: string, actionId: string) { if (!targetSubmissionId.trim() || !actionId.trim() || !await this.persistence.saveWithActionRelease(await this.recordFor(workflow), targetSubmissionId, actionId)) throw new TaxDeclarationError(['Atomic corrected-state persistence requires the exact reserved action.']) }
  async restore(submissionId: string): Promise<DeclarationWorkflow> {
    if (!trustedWorkflowStores.has(this) || !submissionId.trim()) throw new TaxDeclarationError(['Workflow restoration requires the exact configured store and a submission ID.'])
    const candidate = await this.persistence.load(submissionId)
    const record = await validatePersistedWorkflow(candidate, submissionId, this.authenticator)
    if (await this.persistence.loadRevision(submissionId) !== record.revision) throw new TaxDeclarationError(['Persisted workflow revision is stale or has been rolled back.'])
    if (record.snapshot.workflowStoreId !== this.configurationId) throw new TaxDeclarationError(['Persisted workflow is bound to a different durable workflow store.'])
    const restored = DeclarationWorkflow.restorePersisted(record.snapshot, WORKFLOW_STORE_CAPABILITY)
    if (record.snapshot.state === 'accepted') setDeclarationLifecycle(restored, 'accepted')
    else if (record.snapshot.state === 'cancelling' || record.snapshot.state === 'uncertain' && record.snapshot.events.at(-1)?.type === 'cancellation-uncertain') setDeclarationLifecycle(restored, 'cancelling')
    else if (record.snapshot.state === 'corrected') setDeclarationLifecycle(restored, 'corrected')
    else if (record.snapshot.state === 'cancelled') setDeclarationLifecycle(restored, 'cancelled')
    if (['accepted', 'cancelling'].includes(record.snapshot.state) || record.snapshot.events.at(-1)?.type === 'cancellation-uncertain') officiallyAcceptedWorkflows.add(restored)
    if (record.snapshot.state === 'cancelling' || record.snapshot.events.at(-1)?.type === 'cancellation-uncertain') actionableAcceptedWorkflows.add(restored)
    if (record.snapshot.state === 'accepted' && !record.snapshot.correctsId) actionableAcceptedWorkflows.add(restored)
    if (record.snapshot.state === 'accepted' && record.snapshot.correctsId) {
      const predecessor = await validatePersistedWorkflow(await this.persistence.load(record.snapshot.correctsId), record.snapshot.correctsId, this.authenticator)
      if (await this.persistence.loadRevision(record.snapshot.correctsId) !== predecessor.revision || !['accepted', 'corrected'].includes(predecessor.snapshot.state)) throw new TaxDeclarationError(['Accepted correction has no valid durable predecessor lifecycle.'])
      if (predecessor.snapshot.state === 'corrected') { if (predecessor.snapshot.events.at(-1)?.payload.correctionSubmissionId !== restored.submissionId) throw new TaxDeclarationError(['Accepted correction is not durably activated by its finalized predecessor.']); actionableAcceptedWorkflows.add(restored) }
    }
    return restored
  }
  async remove(submissionId: string) { if (!trustedWorkflowStores.has(this) || !submissionId.trim()) throw new TaxDeclarationError(['Workflow outbox removal requires the exact configured store and a submission ID.']); await this.persistence.remove(submissionId) }
  async removeWithActionRelease(submissionId: string, targetSubmissionId: string, actionId: string) { if (!trustedWorkflowStores.has(this) || !submissionId.trim() || !targetSubmissionId.trim() || !actionId.trim()) throw new TaxDeclarationError(['Atomic workflow cleanup requires exact configured store and action identities.']); await this.persistence.removeWithActionRelease(submissionId, targetSubmissionId, actionId) }
  async reserveAction(submissionId: string, actionId: string) { if (!trustedWorkflowStores.has(this) || !submissionId.trim() || !actionId.trim() || !await this.persistence.reserveAction(submissionId, actionId)) throw new TaxDeclarationError(['The active declaration already has a conflicting official action or is no longer accepted.']) }
  async releaseAction(submissionId: string, actionId: string) { if (!trustedWorkflowStores.has(this) || !submissionId.trim() || !actionId.trim()) throw new TaxDeclarationError(['Workflow action release requires the exact configured store and identities.']); await this.persistence.releaseAction(submissionId, actionId) }
  private async recordFor(workflow: DeclarationWorkflow): Promise<PersistedDeclarationWorkflow> {
    if (!trustedWorkflowStores.has(this) || !internallyConstructedWorkflows.has(workflow) || !['submitting', 'cancelling', 'uncertain', 'accepted', 'rejected', 'corrected', 'cancelled'].includes(workflow.state) || !workflow.idempotencyKey || !workflow.gatewayId || workflow.workflowStoreId !== this.configurationId || (['accepted', 'cancelled'].includes(workflow.state) && !workflow.receipt?.trim()) || (workflow.state === 'accepted' && !officiallyAcceptedWorkflows.has(workflow))) throw new TaxDeclarationError(['Only an exact internally constructed workflow bound to this durable store can be persisted.'])
    const snapshot = deepFreeze({ dataset: workflow.dataset, state: workflow.state as PersistedDeclarationWorkflow['snapshot']['state'], events: workflow.events, idempotencyKey: workflow.idempotencyKey, ...(workflow.receipt !== undefined ? { receipt: workflow.receipt } : {}), ...(workflow.correctsId !== undefined ? { correctsId: workflow.correctsId } : {}), submissionId: workflow.submissionId, gatewayId: workflow.gatewayId, workflowStoreId: workflow.workflowStoreId })
    const payload = { version: 1 as const, revision: workflow.events.length, snapshot }; const authenticationTag = await this.authenticator.authenticate(stableJson(payload))
    if (!authenticationTag.trim()) throw new TaxDeclarationError(['Workflow authenticator returned an empty MAC or signature.'])
    return deepFreeze({ ...payload, authenticationTag })
  }
}
export function createConfiguredDeclarationWorkflowStore(persistence: DeclarationWorkflowPersistence, authenticator: DeclarationWorkflowAuthenticator, configurationId: string) { return DeclarationWorkflowStore.configured(persistence, authenticator, configurationId) }
export function createTestDeclarationWorkflowStore(): DeclarationWorkflowStore { if (process.env.NODE_ENV !== 'test') throw new TaxDeclarationError(['The in-memory workflow store is test-only.']); const records = new Map<string, PersistedDeclarationWorkflow>(); const revisions = new Map<string, number>(); const reservations = new Map<string, string>(); const authenticated = new Map<string, string>(); let sequence = 0; const authenticator = createConfiguredDeclarationWorkflowAuthenticator({ authenticate: payload => { const tag = `test-signature-${++sequence}`; authenticated.set(tag, payload); return tag }, verify: (payload, tag) => authenticated.get(tag) === payload }, `test-authenticator-${randomUUID()}`); const commit = (record: PersistedDeclarationWorkflow) => { const id = record.snapshot.submissionId; const revision = revisions.get(id) ?? 0; const current = records.get(id); if (record.revision < revision || record.revision === revision && current && stableJson(current.snapshot) !== stableJson(record.snapshot)) return false; records.set(id, record); revisions.set(id, record.revision); return true }; const canReserve = (submissionId: string, actionId: string) => { const state = records.get(submissionId)?.snapshot.state; const current = reservations.get(submissionId); return state === 'accepted' && (!current || current === actionId) }; return createConfiguredDeclarationWorkflowStore({ save: commit, saveWithActionReservation: (record, submissionId, actionId) => { if (!canReserve(submissionId, actionId) || !commit(record)) return false; reservations.set(submissionId, actionId); return true }, saveWithActionRelease: (record, submissionId, actionId) => { if (reservations.get(submissionId) !== actionId || !commit(record)) return false; reservations.delete(submissionId); return true }, load: submissionId => records.get(submissionId), loadRevision: submissionId => revisions.get(submissionId), remove: submissionId => { records.delete(submissionId) }, removeWithActionRelease: (submissionId, targetSubmissionId, actionId) => { records.delete(submissionId); if (reservations.get(targetSubmissionId) === actionId) reservations.delete(targetSubmissionId) }, reserveAction: (submissionId, actionId) => { if (!canReserve(submissionId, actionId)) return false; reservations.set(submissionId, actionId); return true }, releaseAction: (submissionId, actionId) => { if (reservations.get(submissionId) === actionId) reservations.delete(submissionId) } }, authenticator, `test-store-${randomUUID()}`) }
export async function persistDeclarationWorkflow(workflow: DeclarationWorkflow, store: DeclarationWorkflowStore) { if (!trustedWorkflowStores.has(store)) throw new TaxDeclarationError(['Workflow persistence requires the exact configured store.']); await store.persist(workflow) }
export async function restoreDeclarationWorkflow(submissionId: string, store: DeclarationWorkflowStore) { if (!trustedWorkflowStores.has(store)) throw new TaxDeclarationError(['Workflow restoration requires the exact configured store.']); return store.restore(submissionId) }
export async function persistUncertainWorkflow(workflow: DeclarationWorkflow, store: DeclarationWorkflowStore) { if (workflow.state !== 'uncertain') throw new TaxDeclarationError(['This persistence path accepts only uncertain workflows.']); await persistDeclarationWorkflow(workflow, store) }
export async function restoreUncertainWorkflow(submissionId: string, store: DeclarationWorkflowStore) { const restored = await restoreDeclarationWorkflow(submissionId, store); if (restored.state !== 'uncertain') throw new TaxDeclarationError(['The restored workflow is not uncertain.']); return restored }

async function validatePersistedWorkflow(candidate: unknown, requestedSubmissionId: string, authenticator: DeclarationWorkflowAuthenticator): Promise<PersistedDeclarationWorkflow> {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new TaxDeclarationError(['Persisted workflow record is missing or malformed.'])
  const record = candidate as Partial<PersistedDeclarationWorkflow>; const snapshot = record.snapshot as PersistedDeclarationWorkflow['snapshot'] | undefined
  const payload = { version: record.version, revision: record.revision, snapshot }
  let canonicalPayload: string
  try { canonicalPayload = stableJson(payload) } catch { throw new TaxDeclarationError(['Persisted workflow authenticated integrity check failed.']) }
  if (record.version !== 1 || !Number.isSafeInteger(record.revision) || record.revision !== snapshot?.events?.length || !snapshot || typeof record.authenticationTag !== 'string' || !record.authenticationTag.trim() || !await authenticator.verify(canonicalPayload, record.authenticationTag)) throw new TaxDeclarationError(['Persisted workflow authenticated integrity check failed.'])
  if (!['submitting', 'cancelling', 'uncertain', 'accepted', 'rejected', 'corrected', 'cancelled'].includes(snapshot.state) || snapshot.submissionId !== requestedSubmissionId || !snapshot.gatewayId?.trim() || !snapshot.workflowStoreId?.trim() || !snapshot.idempotencyKey?.trim() || !snapshot.dataset || typeof snapshot.dataset !== 'object' || !snapshot.dataset.taxpayerId?.trim() || !snapshot.dataset.formVersion?.trim() || (['accepted', 'corrected', 'cancelled'].includes(snapshot.state) && !snapshot.receipt?.trim())) throw new TaxDeclarationError(['Persisted workflow identity, state, receipt or dataset is invalid.'])
  if (!Array.isArray(snapshot.events) || !snapshot.events.length || snapshot.events.some((item, index) => !item || typeof item.id !== 'string' || !item.id.trim() || typeof item.type !== 'string' || !item.type.trim() || !isCanonicalInstant(item.at) || index > 0 && Date.parse(item.at) < Date.parse(snapshot.events[index - 1].at) || !item.payload || typeof item.payload !== 'object' || Array.isArray(item.payload)) || new Set(snapshot.events.map(item => item.id)).size !== snapshot.events.length) throw new TaxDeclarationError(['Persisted workflow event history is invalid.'])
  const first = snapshot.events[0]; const last = snapshot.events.at(-1)!; const expectedDatasetHash = datasetHash(snapshot.dataset)
  const hasAcceptedSubmission = snapshot.events.some(item => item.type === 'submission-accepted')
  if (first.payload.datasetHash !== expectedDatasetHash || !['created', 'created-as-correction'].includes(first.type) || (snapshot.state === 'submitting' ? last.type !== 'submission-started' : snapshot.state === 'cancelling' ? last.type !== 'cancellation-started' : snapshot.state === 'uncertain' ? !['submission-uncertain', 'cancellation-uncertain'].includes(last.type) : snapshot.state === 'rejected' ? last.type !== 'submission-rejected' : snapshot.state === 'corrected' ? last.type !== 'correction-accepted' : snapshot.state === 'cancelled' ? last.type !== 'cancellation-accepted' : !hasAcceptedSubmission)) throw new TaxDeclarationError(['Persisted workflow history does not match its dataset and lifecycle state.'])
  const hasCancellationAttempt = snapshot.events.some(item => item.type === 'cancellation-started')
  const expectedKey = last.type.startsWith('cancellation-') || (snapshot.state === 'corrected' && hasCancellationAttempt) ? `cancel:${snapshot.submissionId}` : createHash('sha256').update(`${snapshot.submissionId}:${expectedDatasetHash}`).digest('hex')
  if (snapshot.idempotencyKey !== expectedKey) throw new TaxDeclarationError(['Persisted workflow idempotency key is invalid.'])
  return deepFreeze(record as PersistedDeclarationWorkflow)
}

function requireTrustedGateway(gateway: OfficialTaxGateway) { if (!trustedGatewayInstances.has(gateway)) throw new TaxDeclarationError(['Official workflow requires the exact configured trusted gateway adapter instance.']) }
export function isExactAcceptedDeclarationWorkflow(workflow: DeclarationWorkflow): boolean { return internallyConstructedWorkflows.has(workflow) && officiallyAcceptedWorkflows.has(workflow) && actionableAcceptedWorkflows.has(workflow) && workflow.state === 'accepted' && hasDeclarationLifecycle(workflow, 'accepted') }
function requireInternalWorkflow(workflow: DeclarationWorkflow) { if (!internallyConstructedWorkflows.has(workflow)) throw new TaxDeclarationError(['Official side effects require the exact internally constructed declaration workflow instance.']) }
export async function validateWithGateway(workflow: DeclarationWorkflow, gateway: OfficialTaxGateway): Promise<DeclarationWorkflow> { requireTrustedGateway(gateway); requireInternalWorkflow(workflow); if (workflow.gatewayId && (workflow.gatewayId !== gateway.gatewayId || workflow.workflowStoreId !== gateway.workflowStore.configurationId)) throw new TaxDeclarationError(['Correction validation gateway and workflow-store identities must match those that accepted the original declaration.']); return workflow.validated(await gateway.validate(workflow.dataset), OFFICIAL_GATEWAY_CAPABILITY, gateway.gatewayId, gateway.workflowStore.configurationId) }
export async function submitWithGateway(workflow: DeclarationWorkflow, gateway: OfficialTaxGateway): Promise<DeclarationWorkflow> {
  requireTrustedGateway(gateway)
  requireInternalWorkflow(workflow)
  if (workflow.gatewayId !== gateway.gatewayId || workflow.workflowStoreId !== gateway.workflowStore.configurationId) throw new TaxDeclarationError(['Submission gateway and workflow-store identities must match the gateway that officially validated the declaration.'])
  const submitting = workflow.beginSubmission()
  if (submitting.state !== 'submitting') return submitting
  const correctionAction = submitting.correctsId ? `correct:${submitting.submissionId}` : undefined
  if (submitting.correctsId && correctionAction) await gateway.workflowStore.persistWithActionReservation(submitting, submitting.correctsId, correctionAction)
  else await gateway.workflowStore.persist(submitting)
  const response = submitting.correctsId ? await gateway.correct(submitting.correctsId, submitting.dataset, submitting.idempotencyKey!) : await gateway.submit(submitting.dataset, submitting.idempotencyKey!)
  const result = submitting.submitted(response.outcome, response.receipt, response.errors ?? [], OFFICIAL_GATEWAY_CAPABILITY)
  if (result.state === 'accepted' || result.state === 'uncertain') await gateway.workflowStore.persist(result)
  else if (submitting.correctsId && correctionAction) await gateway.workflowStore.persistWithActionRelease(result, submitting.correctsId, correctionAction)
  else await gateway.workflowStore.persist(result)
  return result
}
export async function recoverWithGateway(workflow: DeclarationWorkflow, gateway: OfficialTaxGateway): Promise<DeclarationWorkflow> {
  requireTrustedGateway(gateway)
  requireInternalWorkflow(workflow)
  if (workflow.gatewayId !== gateway.gatewayId || workflow.workflowStoreId !== gateway.workflowStore.configurationId) throw new TaxDeclarationError(['Recovery gateway and workflow-store identities must match the validating gateway.'])
  if (!['submitting', 'cancelling', 'uncertain'].includes(workflow.state) || !workflow.idempotencyKey) throw new TaxDeclarationError(['Only persisted in-flight or uncertain submissions/cancellations can be recovered.'])
  const response = await gateway.recover(workflow.idempotencyKey)
  const cancellationEvent = [...workflow.events].reverse().find(item => ['cancellation-started', 'cancellation-uncertain'].includes(item.type))
  let result: DeclarationWorkflow
  if (cancellationEvent) result = response.outcome === 'uncertain' && workflow.state === 'uncertain' ? workflow : workflow.cancellationOutcome(response.outcome, String(cancellationEvent.payload.cancellationActor ?? ''), response.receipt, response.errors ?? [], workflow.idempotencyKey, OFFICIAL_GATEWAY_CAPABILITY)
  else result = response.outcome === 'uncertain' && workflow.state === 'uncertain' ? workflow : workflow.submitted(response.outcome, response.receipt, response.errors ?? [], OFFICIAL_GATEWAY_CAPABILITY)
  if (cancellationEvent && response.outcome !== 'uncertain') await gateway.workflowStore.persistWithActionRelease(result, workflow.submissionId, `cancel:${workflow.submissionId}`)
  else if (result.state === 'accepted' || result.state === 'uncertain' || result.state === 'cancelling' || result.state === 'cancelled') await gateway.workflowStore.persist(result)
  else if (workflow.correctsId) await gateway.workflowStore.persistWithActionRelease(result, workflow.correctsId, `correct:${workflow.submissionId}`)
  else await gateway.workflowStore.persist(result)
  return result
}
export async function cancelWithGateway(workflow: DeclarationWorkflow, actor: string, gateway: OfficialTaxGateway): Promise<DeclarationWorkflow> {
  requireTrustedGateway(gateway)
  requireInternalWorkflow(workflow)
  if (workflow.gatewayId !== gateway.gatewayId || workflow.workflowStoreId !== gateway.workflowStore.configurationId) throw new TaxDeclarationError(['Cancellation gateway and workflow-store identities must match the validating gateway.'])
  if (workflow.state !== 'accepted') throw new TaxDeclarationError(['Only accepted declarations can be cancelled.'])
  if (!officiallyAcceptedWorkflows.has(workflow) || !actionableAcceptedWorkflows.has(workflow)) throw new TaxDeclarationError(['Only the exact actionable officially accepted declaration can be cancelled.'])
  if (!actor.trim()) throw new TaxDeclarationError(['Explicit cancelling actor is required.'])
  const idempotencyKey = `cancel:${workflow.submissionId}`; const cancelling = workflow.beginCancellation(actor, idempotencyKey)
  try { await gateway.workflowStore.persistWithActionReservation(cancelling, workflow.submissionId, idempotencyKey) } catch (error) { setDeclarationLifecycle(workflow, 'accepted'); officiallyAcceptedWorkflows.delete(cancelling); actionableAcceptedWorkflows.delete(cancelling); officiallyAcceptedWorkflows.add(workflow); actionableAcceptedWorkflows.add(workflow); throw error }
  const response = await gateway.cancel(workflow.submissionId, idempotencyKey)
  const result = cancelling.cancellationOutcome(response.outcome, actor, response.receipt, response.errors ?? [], idempotencyKey, OFFICIAL_GATEWAY_CAPABILITY)
  if (response.outcome !== 'uncertain') await gateway.workflowStore.persistWithActionRelease(result, workflow.submissionId, idempotencyKey)
  else if (result.state === 'uncertain') await gateway.workflowStore.persist(result)
  else await gateway.workflowStore.remove(result.submissionId)
  return result
}
export async function finalizeAcceptedCorrection(original: DeclarationWorkflow, correction: DeclarationWorkflow, store: DeclarationWorkflowStore, now = new Date().toISOString()): Promise<DeclarationWorkflow> {
  if (!trustedWorkflowStores.has(store)) throw new TaxDeclarationError(['Correction finalization requires the exact durable workflow store.'])
  if (original.workflowStoreId !== store.configurationId || correction.workflowStoreId !== store.configurationId) throw new TaxDeclarationError(['Correction finalization requires the durable store bound to both accepted workflows.'])
  if (!internallyConstructedWorkflows.has(original) || !internallyConstructedWorkflows.has(correction) || !officiallyAcceptedWorkflows.has(original) || !officiallyAcceptedWorkflows.has(correction) || !hasDeclarationLifecycle(original, 'accepted') || !hasDeclarationLifecycle(correction, 'accepted') || original.state !== 'accepted' || correction.state !== 'accepted' || correction.correctsId !== original.submissionId) throw new TaxDeclarationError(['Correction finalization requires exact accepted linked workflows before durable reservation.'])
  const actionId = `correct:${correction.submissionId}`
  await store.reserveAction(original.submissionId, actionId)
  const result = original.finalizedByCorrection(correction, OFFICIAL_GATEWAY_CAPABILITY, now)
  await store.persistWithActionRelease(result, original.submissionId, actionId)
  setDeclarationLifecycle(result, 'corrected')
  officiallyAcceptedWorkflows.delete(original); actionableAcceptedWorkflows.delete(original); actionableAcceptedWorkflows.add(correction)
  return result
}

export function nextBusinessDay(value: string, holidays: ReadonlySet<string> = germanNationalHolidays(Number(value.slice(0, 4)), Number(value.slice(0, 4)) + 1)): string {
  if (!isRealDate(value)) throw new TaxDeclarationError([`Invalid calendar date ${value}.`])
  const date = new Date(`${value}T00:00:00Z`)
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6 || holidays.has(date.toISOString().slice(0, 10))) date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
}

export function germanNationalHolidays(fromYear: number, toYear: number): ReadonlySet<string> {
  if (!Number.isSafeInteger(fromYear) || !Number.isSafeInteger(toYear) || fromYear < 1000 || toYear > 9999 || fromYear > toYear) throw new TaxDeclarationError(['Holiday bounds must be ordered safe four-digit calendar years.'])
  const holidays = new Set<string>()
  for (let year = fromYear; year <= toYear; year++) {
    for (const monthDay of ['01-01', '05-01', '10-03', '12-25', '12-26']) holidays.add(`${year}-${monthDay}`)
    const easter = easterSunday(year)
    for (const offset of [-2, 1, 39, 50]) { const day = new Date(easter); day.setUTCDate(day.getUTCDate() + offset); holidays.add(day.toISOString().slice(0, 10)) }
  }
  return holidays
}

function isCanonicalInstant(value: unknown): value is string { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false; const normalized = value.includes('.') ? value : value.replace(/Z$/, '.000Z'); const parsed = new Date(value); return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === normalized }
function event(at: string, type: string, payload: Record<string, unknown>, actor?: string, previousAt?: string): DeclarationEvent { if (!isCanonicalInstant(at) || previousAt && Date.parse(at) < Date.parse(previousAt)) throw new TaxDeclarationError(['Declaration event timestamp must be a canonical date-time no earlier than the preceding event.']); return deepFreeze({ id: randomUUID(), at, type, ...(actor !== undefined ? { actor } : {}), payload }) }
function datasetHash(dataset: DeclarationDataset) { return createHash('sha256').update(stableJson(dataset)).digest('hex') }
function stableJson(value: unknown): string {
  const active = new WeakSet<object>(); let nodes = 0
  const encode = (item: unknown, depth: number): string => {
    if (depth > 64 || ++nodes > 100_000) throw new TaxDeclarationError(['Canonical data exceeds structural limits.'])
    if (item === undefined) throw new TaxDeclarationError(['Canonical data contains an unsupported value.'])
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) { const encoded = JSON.stringify(item); if (encoded.length > 5 * 1024 * 1024) throw new TaxDeclarationError(['Canonical data exceeds size limits.']); return encoded }
    if (!item || typeof item !== 'object') throw new TaxDeclarationError(['Canonical data contains an unsupported value.'])
    if (active.has(item)) throw new TaxDeclarationError(['Canonical data contains a cycle.'])
    active.add(item)
    try {
      if (Array.isArray(item) && (Object.keys(item).length !== item.length || Object.keys(item).some((key, index) => key !== String(index)))) throw new TaxDeclarationError(['Canonical data contains a sparse or extended array.'])
      const keys = Array.isArray(item) ? [] : Object.keys(item)
      if (keys.length > 100_000 || !Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new TaxDeclarationError(['Canonical data exceeds structural limits.'])
      const encoded = Array.isArray(item) ? `[${item.map(value => encode(value, depth + 1)).join(',')}]` : `{${keys.sort((a, b) => a < b ? -1 : a > b ? 1 : 0).map(key => `${JSON.stringify(key)}:${encode((item as Record<string, unknown>)[key], depth + 1)}`).join(',')}}`
      if (encoded.length > 5 * 1024 * 1024) throw new TaxDeclarationError(['Canonical data exceeds size limits.'])
      return encoded
    } finally { active.delete(item) }
  }
  return encode(value, 0)
}
function pad(value: number) { return String(value).padStart(2, '0') }
function assertFilingFrequency(value: FilingFrequency) { if (!['monthly', 'quarterly', 'exempt'].includes(value)) throw new TaxDeclarationError(['VAT filing frequency must use a supported canonical discriminant.']) }
function daysInMonth(year: number, month: number) { return new Date(Date.UTC(year, month, 0)).getUTCDate() }
function isRealDate(value: string) { if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const date = new Date(`${value}T00:00:00Z`); return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value }
function assertCanonicalFilingPeriod(period: FilingPeriod) {
  const monthly = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period.key)
  const quarterly = /^(\d{4})-Q([1-4])$/.exec(period.key)
  let expectedFrom = ''; let expectedTo = ''
  if (monthly) { const year = Number(monthly[1]); const month = Number(monthly[2]); expectedFrom = `${year}-${pad(month)}-01`; expectedTo = `${year}-${pad(month)}-${daysInMonth(year, month)}` }
  else if (quarterly) { const year = Number(quarterly[1]); const endMonth = Number(quarterly[2]) * 3; expectedFrom = `${year}-${pad(endMonth - 2)}-01`; expectedTo = `${year}-${pad(endMonth)}-${daysInMonth(year, endMonth)}` }
  if (!expectedFrom || period.from !== expectedFrom || period.to !== expectedTo || !isRealDate(period.dueDate)) throw new TaxDeclarationError([`Filing period ${period.key} must use its canonical boundaries and a real due date.`])
}
function safeSum(values: readonly number[], label: string) { let result = 0; for (const value of values) { if (!Number.isSafeInteger(value)) throw new TaxDeclarationError([`${label} contains an unsafe monetary value.`]); result += value; if (!Number.isSafeInteger(result)) throw new TaxDeclarationError([`${label} exceeds safe integer cents.`]) } return result }
function safeBigIntCents(value: bigint, label: string) { const result = Number(value); if (!Number.isSafeInteger(result)) throw new TaxDeclarationError([`${label} exceeds safe integer cents.`]); return result }
function exactRoundProduct(value: number, multiplier: number, denominator: number, label: string) { if (![value, multiplier, denominator].every(Number.isSafeInteger) || denominator <= 0) throw new TaxDeclarationError([`${label} has invalid exact-arithmetic operands.`]); const product = BigInt(value) * BigInt(multiplier); const sign = product < BigInt(0) ? BigInt(-1) : BigInt(1); const result = sign * ((sign * product + BigInt(Math.floor(denominator / 2))) / BigInt(denominator)); return safeBigIntCents(result, label) }
function easterSunday(year: number) { const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451), month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1; return new Date(Date.UTC(year, month - 1, day)) }
function deepFreeze<T>(value: T): Readonly<T> { if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(deepFreeze) } return value }
function cloneDataset(dataset: DeclarationDataset): DeclarationDataset { return deepFreeze({ ...dataset, fields: { ...dataset.fields }, drilldown: Object.fromEntries(Object.entries(dataset.drilldown).map(([field, ids]) => [field, [...ids]])) }) as DeclarationDataset }

export const taxFormRegistry = new FormRegistry([
  ...(['USTVA', 'UST_ANNUAL', 'SONDERVORAUSZAHLUNG', 'DAUERFRISTVERLAENGERUNG', 'ZM', 'OSS', 'KST', 'GEWST', 'ZERLEGUNG', 'EST_BUSINESS', 'FESTSTELLUNG'] as DeclarationKind[]).map(kind => ({ kind, version: `${kind}-2026.1`, validFrom: '2026', validTo: '2026', requiredFields: kind === 'ZM' ? ['SUMME', 'USTID_OK'] : kind === 'OSS' ? ['UMSATZ', 'STEUER'] : ['USTVA', 'UST_ANNUAL', 'SONDERVORAUSZAHLUNG', 'DAUERFRISTVERLAENGERUNG'].includes(kind) ? ['ZAHLLAST'] : kind === 'KST' ? ['STEUERLICHES_ERGEBNIS', 'KST_SCHULD'] : kind === 'GEWST' ? ['GEWERBEERTRAG', 'GEWST_SCHULD', 'GEMEINDE', 'HEBESATZ_BP'] : kind === 'ZERLEGUNG' ? ['GEWERBEERTRAG', 'ZERLEGUNGSANTEILE'] : kind === 'EST_BUSINESS' ? ['EINKUENFTE_GEWERBEBETRIEB', 'EST_SCHULD'] : ['FESTZUSTELLENDE_EINKUENFTE'], fieldNames: {} })),
])
