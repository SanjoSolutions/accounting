export type VatCase = 'standard' | 'reduced' | 'zero' | 'exempt' | 'reverse-charge' | 'intra-eu' | 'intra-eu-supply' | 'intra-eu-service' | 'oss-sale' | 'import' | 'deposit' | 'final-invoice' | 'private-use'
export type VatInputMode = 'net' | 'gross'

export interface VatRule {
  id: string
  version: number
  validFrom: string
  validTo?: string
  jurisdiction: string
  case: VatCase
  rateBasisPoints: number
  deductibleShareBasisPoints: number
  outputAccount: string
  inputAccount?: string
  returnBoxes: readonly VatBoxMapping[]
  reason: string
  reverseChargeRole?: 'recipient' | 'supplier'
}
export interface VatBoxMapping { box: string; value: 'net-base' | 'output-tax' | 'input-tax'; direction?: 'sale' | 'purchase' }
export interface VatSourceSplit {
  ownerId: string; sourceId: string; amountCents: number; mode: VatInputMode; taxPoint: string; ruleId: string
  direction?: 'sale' | 'purchase'; reversalOf?: string; originalTaxPoint?: string; customerVatId?: string; customerCountry?: string
  customerType?: 'business' | 'consumer'; customerVatIdValidation?: VatIdValidationEvidence; supplyKind?: 'goods' | 'services'
  transportEvidence?: VatTransportEvidence
}
export interface VatTransportEvidence { ownerId: string; type: 'dispatch-document' | 'carrier-document'; reference: string; dispatchedFromCountry: string; destinationCountry: string; sourceId: string; provider: string; verificationId: string; verifiedAt: string }
export type VatTransportEvidenceClaim = Pick<VatTransportEvidence, 'ownerId' | 'type' | 'reference' | 'dispatchedFromCountry' | 'destinationCountry' | 'sourceId'>
export interface VatIdValidationEvidence { normalizedVatId: string; countryCode: string; provider: string; validationId: string; validatedAt: string }
export interface VatPostingDetail extends VatSourceSplit {
  jurisdiction: string; ruleVersion: number; case: VatCase; rateBasisPoints: number
  netBaseCents: number; taxCents: number; deductibleTaxCents: number; grossCents: number
  outputTaxCents: number; inputTaxCents: number; returnBoxes: readonly VatBoxMapping[]; reason: string
}

export class VatValidationError extends Error { constructor(readonly issues: readonly string[]) { super(issues.join(' ')); this.name = 'VatValidationError' } }
const trustedVatPostings = new WeakSet<object>()
const trustedVatRuleBooks = new WeakSet<object>()
const trustedVatIdValidationEvidence = new WeakSet<object>()
const trustedVatIdValidators = new WeakSet<object>()
const trustedTransportEvidence = new WeakSet<object>()
const trustedTransportVerifiers = new WeakSet<object>()
const VAT_POSTING_CAPABILITY = Symbol('trusted-vat-posting')
export interface VatIdValidator { configurationId: string; validate(normalizedVatId: string, countryCode: string): Promise<{ valid: boolean; validationId?: string; validatedAt?: string }> }
export function createConfiguredVatIdValidator(adapter: Omit<VatIdValidator, 'configurationId'>, configurationId: string): VatIdValidator { if (!configurationId.trim()) throw new VatValidationError(['VAT-ID validator configuration identity is required.']); const validator = Object.freeze({ configurationId, validate: adapter.validate.bind(adapter) }); trustedVatIdValidators.add(validator); return validator }
export async function validateVatIdWithAuthority(value: string, countryCode: string, supplyKind: 'goods' | 'services', validator: VatIdValidator): Promise<VatIdValidationEvidence> { if (!trustedVatIdValidators.has(validator)) throw new VatValidationError(['VAT-ID validation requires the exact configured authoritative validator.']); const normalizedVatId = normalizeVatId(value); if (!matchesCountryVatId(normalizedVatId, countryCode, supplyKind)) throw new VatValidationError(['VAT ID does not match the country-specific syntax.']); const result = await validator.validate(normalizedVatId, countryCode); if (!result.valid || !result.validationId?.trim() || !isCanonicalInstant(result.validatedAt)) throw new VatValidationError(['Authoritative VAT-ID validation failed or returned incomplete evidence.']); const evidence = Object.freeze({ normalizedVatId, countryCode, provider: validator.configurationId, validationId: result.validationId, validatedAt: result.validatedAt }); trustedVatIdValidationEvidence.add(evidence); return evidence }
export async function restoreVatIdValidationEvidenceWithAuthority(candidate: VatIdValidationEvidence, supplyKind: 'goods' | 'services', validator: VatIdValidator): Promise<VatIdValidationEvidence> { if (!trustedVatIdValidators.has(validator) || candidate.provider !== validator.configurationId || !matchesCountryVatId(candidate.normalizedVatId, candidate.countryCode, supplyKind) || !isCanonicalInstant(candidate.validatedAt)) throw new VatValidationError(['Persisted VAT-ID evidence requires its exact configured authority and canonical fields.']); const result = await validator.validate(candidate.normalizedVatId, candidate.countryCode); if (!result.valid || result.validationId !== candidate.validationId || result.validatedAt !== candidate.validatedAt) throw new VatValidationError(['Persisted VAT-ID evidence no longer matches authoritative validation.']); const restored = Object.freeze({ ...candidate }); trustedVatIdValidationEvidence.add(restored); return restored }
export function normalizeVatId(value: string) { return value.replace(/[\s.-]/g, '').toUpperCase() }
export function createTestVatIdValidationEvidence(value: string, countryCode: string, validatedAt = '2026-01-01T00:00:00.000Z'): VatIdValidationEvidence { if (process.env.NODE_ENV !== 'test') throw new VatValidationError(['The in-memory VAT-ID evidence factory is test-only.']); const normalizedVatId = normalizeVatId(value); if (!matchesCountryVatId(normalizedVatId, countryCode, 'goods') || !isCanonicalInstant(validatedAt)) throw new VatValidationError(['Test VAT-ID evidence requires a country-specific valid identifier and canonical validation instant.']); const evidence = Object.freeze({ normalizedVatId, countryCode, provider: 'test-vies', validationId: `test:${normalizedVatId}:${validatedAt}`, validatedAt }); trustedVatIdValidationEvidence.add(evidence); return evidence }
export function isTrustedVatIdValidation(evidence: VatIdValidationEvidence | undefined, value: string, countryCode: string, supplyKind: 'goods' | 'services', taxPoint?: string) { return Boolean(evidence && trustedVatIdValidationEvidence.has(evidence) && evidence.normalizedVatId === normalizeVatId(value) && evidence.countryCode === countryCode && evidence.provider.trim() && evidence.validationId.trim() && isCanonicalInstant(evidence.validatedAt) && matchesCountryVatId(evidence.normalizedVatId, countryCode, supplyKind) && (taxPoint === undefined || isVatIdValidationEffectiveAt(evidence.validatedAt, taxPoint))) }
export interface VatTransportEvidenceVerifier { configurationId: string; verify(claim: VatTransportEvidenceClaim): Promise<{ verified: boolean; verificationId?: string; verifiedAt?: string }> }
export function createConfiguredVatTransportEvidenceVerifier(adapter: Omit<VatTransportEvidenceVerifier, 'configurationId'>, configurationId: string): VatTransportEvidenceVerifier { if (!configurationId.trim()) throw new VatValidationError(['Transport-evidence verifier configuration identity is required.']); const verifier = Object.freeze({ configurationId, verify: adapter.verify.bind(adapter) }); trustedTransportVerifiers.add(verifier); return verifier }
export async function verifyVatTransportEvidenceWithAuthority(claim: VatTransportEvidenceClaim, verifier: VatTransportEvidenceVerifier): Promise<VatTransportEvidence> { if (!trustedTransportVerifiers.has(verifier) || !isCanonicalTransportClaim(claim, claim.destinationCountry)) throw new VatValidationError(['Transport evidence requires an exact configured verifier and a canonical outbound claim.']); const result = await verifier.verify(Object.freeze({ ...claim })); if (!result.verified || !result.verificationId?.trim() || !isCanonicalInstant(result.verifiedAt)) throw new VatValidationError(['Authoritative transport-evidence verification failed or returned incomplete evidence.']); const evidence = Object.freeze({ ...claim, provider: verifier.configurationId, verificationId: result.verificationId, verifiedAt: result.verifiedAt }); trustedTransportEvidence.add(evidence); return evidence }
export async function restoreVatTransportEvidenceWithAuthority(candidate: VatTransportEvidence, verifier: VatTransportEvidenceVerifier): Promise<VatTransportEvidence> { const claim: VatTransportEvidenceClaim = { ownerId: candidate.ownerId, type: candidate.type, reference: candidate.reference, dispatchedFromCountry: candidate.dispatchedFromCountry, destinationCountry: candidate.destinationCountry, sourceId: candidate.sourceId }; if (!trustedTransportVerifiers.has(verifier) || candidate.provider !== verifier.configurationId || !isCanonicalTransportClaim(claim, candidate.destinationCountry) || !isCanonicalInstant(candidate.verifiedAt)) throw new VatValidationError(['Persisted transport evidence requires its exact configured authority and canonical fields.']); const result = await verifier.verify(Object.freeze(claim)); if (!result.verified || result.verificationId !== candidate.verificationId || result.verifiedAt !== candidate.verifiedAt) throw new VatValidationError(['Persisted transport evidence no longer matches authoritative verification.']); const restored = Object.freeze({ ...candidate }); trustedTransportEvidence.add(restored); return restored }
export function createTestVatTransportEvidence(claim: VatTransportEvidenceClaim): VatTransportEvidence { if (process.env.NODE_ENV !== 'test' || !isCanonicalTransportClaim(claim, claim.destinationCountry)) throw new VatValidationError(['The in-memory transport-evidence factory is test-only and requires a canonical outbound claim.']); const evidence = Object.freeze({ ...claim, provider: 'test-document-registry', verificationId: `test:${claim.reference}`, verifiedAt: '2026-01-01T00:00:00.000Z' }); trustedTransportEvidence.add(evidence); return evidence }
export interface VatReversalPersistence { appendAllUnique(ownerId: string, postingIdentities: readonly string[]): boolean; snapshot(ownerId: string): readonly string[] }
const trustedReversalStores = new WeakSet<object>()
const configuredReversalPersistence = new Map<string, VatReversalPersistence>()
export class VatReversalRegistry {
  readonly ownerId: string
  private constructor(ownerId: string, private readonly persistence: VatReversalPersistence) { this.ownerId = ownerId; trustedReversalStores.add(this); Object.freeze(this) }
  static configured(ownerId: string, persistence: VatReversalPersistence) { if (!ownerId.trim() || typeof persistence.appendAllUnique !== 'function' || typeof persistence.snapshot !== 'function') throw new VatValidationError(['A canonical owner and transactional reversal persistence adapter are required.']); const existing = configuredReversalPersistence.get(ownerId); if (existing && existing !== persistence) throw new VatValidationError(['The canonical owner already has a configured reversal persistence adapter and cannot be reset.']); configuredReversalPersistence.set(ownerId, persistence); return new VatReversalRegistry(ownerId, persistence) }
  static test(ownerId: string, consumedPostingIdentities: readonly string[] = []) { if (process.env.NODE_ENV !== 'test') throw new VatValidationError(['The in-memory reversal store is test-only.']); const consumed = new Set(consumedPostingIdentities); return new VatReversalRegistry(ownerId, { appendAllUnique: (requestedOwner, identities) => { if (requestedOwner !== ownerId || identities.some(identity => consumed.has(identity))) return false; identities.forEach(identity => consumed.add(identity)); return true }, snapshot: requestedOwner => requestedOwner === ownerId ? Object.freeze([...consumed].sort()) : Object.freeze([]) }) }
  snapshot(): readonly string[] { return Object.freeze([...this.persistence.snapshot(this.ownerId)].sort()) }
  hasCanonicalPosting(posting: VatPostingDetail, capability: symbol) { if (capability !== VAT_POSTING_CAPABILITY || posting.ownerId !== this.ownerId) return false; const snapshot = this.persistence.snapshot(this.ownerId); return snapshot.includes(`bound-source:${JSON.stringify(posting.sourceId)}`) && snapshot.includes(`original:${JSON.stringify(posting.sourceId)}:${postingIdentity(posting)}`) }
  registerOriginal(posting: VatPostingDetail, capability: symbol) { this.commitBatch([posting], [], capability) }
  consumeOriginals(originals: readonly { sourceId: string; identity: string }[], capability: symbol) { this.commitBatch([], originals, capability) }
  commitBatch(postings: readonly VatPostingDetail[], originals: readonly { sourceId: string; identity: string }[], capability: symbol) {
    if (capability !== VAT_POSTING_CAPABILITY || !trustedReversalStores.has(this)) throw new VatValidationError(['Only the trusted VAT calculation boundary can commit canonical originals or reversals.'])
    const snapshot = this.persistence.snapshot(this.ownerId); const entries: string[] = []; const batchBindings = new Set<string>()
    for (const posting of postings) { if (!trustedVatPostings.has(posting) || posting.ownerId !== this.ownerId || !posting.sourceId.trim()) throw new VatValidationError(['Only newly calculated trusted postings can be registered in their canonical owner store.']); const sourceMarker = `bound-source:${JSON.stringify(posting.sourceId)}`; const bindingPrefix = `original:${JSON.stringify(posting.sourceId)}:`; const binding = `${bindingPrefix}${postingIdentity(posting)}`; const existing = snapshot.find(item => item.startsWith(bindingPrefix)); if (existing && (existing !== binding || !snapshot.includes(sourceMarker))) throw new VatValidationError(['The owner/source ID is already bound to a different immutable canonical VAT original.']); if (!existing) { entries.push(sourceMarker, binding); batchBindings.add(binding) } }
    const sourceIds = new Set<string>(); for (const original of originals) { if (!original.sourceId.trim() || sourceIds.has(original.sourceId)) throw new VatValidationError(['A reversal transaction contains duplicate or blank original source IDs.']); sourceIds.add(original.sourceId); const sourceMarker = `bound-source:${JSON.stringify(original.sourceId)}`; const binding = `original:${JSON.stringify(original.sourceId)}:${original.identity}`; if (!(snapshot.includes(sourceMarker) && snapshot.includes(binding)) && !(entries.includes(sourceMarker) && batchBindings.has(binding))) throw new VatValidationError(['Reversal requires the canonical owner/source-bound original previously registered in durable persistence.']); entries.push(`reversed:${original.identity}`) }
    if (new Set(entries).size !== entries.length || entries.length && !this.persistence.appendAllUnique(this.ownerId, entries)) throw new VatValidationError(['The canonical VAT original or reversal conflicts with durable persistence.'])
  }
}
export function createConfiguredVatReversalStore(ownerId: string, persistence: VatReversalPersistence) { return VatReversalRegistry.configured(ownerId, persistence) }
export function createTestVatReversalStore(ownerId: string, consumedPostingIdentities: readonly string[] = []) { return VatReversalRegistry.test(ownerId, consumedPostingIdentities) }

export class VatRuleBook {
  readonly rules: readonly VatRule[]
  constructor(rules: readonly VatRule[]) {
    const issues: string[] = []
    for (const rule of rules) {
      if (!rule.id.trim() || rule.id !== rule.id.trim()) issues.push('VAT rule identifiers must be canonical nonblank values.')
      if (!rule.jurisdiction.trim() || rule.jurisdiction !== rule.jurisdiction.trim() || !rule.outputAccount.trim() || rule.outputAccount !== rule.outputAccount.trim() || rule.inputAccount !== undefined && (!rule.inputAccount.trim() || rule.inputAccount !== rule.inputAccount.trim()) || !rule.reason.trim()) issues.push(`VAT rule ${rule.id || '(blank)'} requires canonical jurisdiction, account and audit-reason provenance.`)
      if (!['standard', 'reduced', 'zero', 'exempt', 'reverse-charge', 'intra-eu', 'intra-eu-supply', 'intra-eu-service', 'oss-sale', 'import', 'deposit', 'final-invoice', 'private-use'].includes(rule.case)) issues.push(`Unsupported VAT case discriminant for ${rule.id}.`)
      if (rule.returnBoxes.some(box => !box.box.trim() || !['net-base', 'output-tax', 'input-tax'].includes(box.value) || box.direction !== undefined && !['sale', 'purchase'].includes(box.direction))) issues.push(`Unsupported VAT return-box mapping discriminant for ${rule.id}.`)
      if (new Set(rule.returnBoxes.map(box => `${box.box}\u0000${box.value}\u0000${box.direction ?? ''}`)).size !== rule.returnBoxes.length) issues.push(`Duplicate VAT return-box mapping for ${rule.id}.`)
      if (!Number.isSafeInteger(rule.version) || rule.version <= 0 || rules.some(other => other !== rule && other.id === rule.id && other.version === rule.version)) issues.push(`Invalid or duplicate positive audit version for ${rule.id}.`)
      if (!isRealDate(rule.validFrom) || (rule.validTo && (!isRealDate(rule.validTo) || rule.validTo < rule.validFrom))) issues.push(`Invalid effective dates for ${rule.id}.`)
      if (!Number.isInteger(rule.rateBasisPoints) || rule.rateBasisPoints < 0 || rule.rateBasisPoints > 10_000) issues.push(`Invalid VAT rate for ${rule.id}.`)
      if (!Number.isInteger(rule.deductibleShareBasisPoints) || rule.deductibleShareBasisPoints < 0 || rule.deductibleShareBasisPoints > 10_000) issues.push(`Invalid deductible share for ${rule.id}.`)
      if (['zero', 'exempt'].includes(rule.case) && rule.rateBasisPoints !== 0) issues.push(`${rule.case} rule ${rule.id} must have a zero rate.`)
      if (rule.case === 'reverse-charge' && !rule.reverseChargeRole) issues.push(`Reverse-charge rule ${rule.id} must identify the supplier or recipient role.`)
      if (rule.case !== 'reverse-charge' && rule.reverseChargeRole) issues.push(`Only reverse-charge rules may identify a reverse-charge role (${rule.id}).`)
      if (rules.some(other => other !== rule && other.id === rule.id && overlaps(rule, other))) issues.push(`Overlapping effective versions for ${rule.id}.`)
    }
    if (issues.length) throw new VatValidationError([...new Set(issues)])
    this.rules = Object.freeze(rules.map(rule => Object.freeze({ ...rule, returnBoxes: Object.freeze(rule.returnBoxes.map(box => Object.freeze({ ...box }))) })))
    Object.freeze(this)
  }
  at(id: string, taxPoint: string): VatRule {
    if (!isRealDate(taxPoint)) throw new VatValidationError([`Invalid tax point ${taxPoint}.`])
    const rule = this.rules.find(candidate => candidate.id === id && candidate.validFrom <= taxPoint && (!candidate.validTo || taxPoint <= candidate.validTo))
    if (!rule) throw new VatValidationError([`No VAT rule ${id} applies at ${taxPoint}.`])
    return rule
  }
}
export function createConfiguredVatRuleBook(rules: readonly VatRule[], configurationId: string): VatRuleBook { if (!configurationId.trim()) throw new VatValidationError(['Authoritative VAT rule-book configuration identity is required.']); const book = new VatRuleBook(rules); trustedVatRuleBooks.add(book); return book }
export function createTestVatRuleBook(rules: readonly VatRule[]): VatRuleBook { if (process.env.NODE_ENV !== 'test') throw new VatValidationError(['The in-memory VAT rule-book authority is test-only.']); const book = new VatRuleBook(rules); trustedVatRuleBooks.add(book); return book }

export function calculateVat(split: VatSourceSplit, rules: VatRuleBook, original?: VatPostingDetail, reversalRegistry?: VatReversalRegistry): VatPostingDetail {
  return calculateVatInternal(split, rules, original, reversalRegistry)
}
export function restoreVatPosting(candidate: VatPostingDetail, rules: VatRuleBook, reversalRegistry: VatReversalRegistry, original?: VatPostingDetail): VatPostingDetail { if (!trustedVatRuleBooks.has(rules) || !trustedReversalStores.has(reversalRegistry) || candidate.ownerId !== reversalRegistry.ownerId) throw new VatValidationError(['Persisted VAT posting restoration requires the exact authoritative rule book and durable owner store.']); const allowed = new Set(['ownerId', 'sourceId', 'amountCents', 'mode', 'taxPoint', 'ruleId', 'direction', 'reversalOf', 'originalTaxPoint', 'customerVatId', 'customerCountry', 'customerType', 'customerVatIdValidation', 'supplyKind', 'transportEvidence', 'jurisdiction', 'ruleVersion', 'case', 'rateBasisPoints', 'netBaseCents', 'taxCents', 'deductibleTaxCents', 'grossCents', 'outputTaxCents', 'inputTaxCents', 'returnBoxes', 'reason']); if (Object.keys(candidate).some(key => !allowed.has(key))) throw new VatValidationError(['Persisted VAT postings contain unexpected fields; document provenance requires its separate verified attachment boundary.']); const source: VatSourceSplit = { ownerId: candidate.ownerId, sourceId: candidate.sourceId, amountCents: candidate.reversalOf ? Math.abs(candidate.amountCents) : candidate.amountCents, mode: candidate.mode, taxPoint: candidate.taxPoint, ruleId: candidate.ruleId, ...(candidate.direction !== undefined ? { direction: candidate.direction } : {}), ...(candidate.reversalOf !== undefined ? { reversalOf: candidate.reversalOf } : {}), ...(candidate.originalTaxPoint !== undefined ? { originalTaxPoint: candidate.originalTaxPoint } : {}), ...(candidate.customerVatId !== undefined ? { customerVatId: candidate.customerVatId } : {}), ...(candidate.customerCountry !== undefined ? { customerCountry: candidate.customerCountry } : {}), ...(candidate.customerType !== undefined ? { customerType: candidate.customerType } : {}), ...(candidate.customerVatIdValidation !== undefined ? { customerVatIdValidation: candidate.customerVatIdValidation } : {}), ...(candidate.supplyKind !== undefined ? { supplyKind: candidate.supplyKind } : {}), ...(candidate.transportEvidence !== undefined ? { transportEvidence: candidate.transportEvidence } : {}) }; const restored = calculateVatInternal(source, rules, original, reversalRegistry, [], []); if (postingIdentity(restored) !== postingIdentity(candidate) || !reversalRegistry.hasCanonicalPosting(candidate, VAT_POSTING_CAPABILITY)) throw new VatValidationError(['Persisted VAT posting does not match its canonical calculated durable binding.']); return restored }
export function isTrustedVatPosting(posting: VatPostingDetail): boolean { return trustedVatPostings.has(posting) }
function calculateVatInternal(split: VatSourceSplit, rules: VatRuleBook, original?: VatPostingDetail, reversalRegistry?: VatReversalRegistry, pendingReversals?: { sourceId: string; identity: string }[], pendingOriginals?: VatPostingDetail[]): VatPostingDetail {
  if (!split.ownerId?.trim()) throw new VatValidationError(['VAT calculations require a canonical company/ledger owner identity.'])
  if (!split.sourceId?.trim()) throw new VatValidationError(['VAT calculations require a nonblank canonical source ID.'])
  if (!['net', 'gross'].includes(split.mode) || split.direction !== undefined && !['sale', 'purchase'].includes(split.direction)) throw new VatValidationError(['VAT source mode and direction must use supported canonical discriminants.'])
  if (split.reversalOf && !trustedVatRuleBooks.has(rules)) throw new VatValidationError(['VAT reversals require the exact trusted authoritative rule book before durable side effects.'])
  if (!Number.isSafeInteger(split.amountCents) || split.amountCents < 0) throw new VatValidationError(['Source amount must be non-negative safe-integer cents; use reversalOf for credits.'])
  if (!isRealDate(split.taxPoint)) throw new VatValidationError([`Invalid tax point ${split.taxPoint}.`])
  if (split.reversalOf) {
    if (!reversalRegistry || !trustedReversalStores.has(reversalRegistry) || reversalRegistry.ownerId !== split.ownerId) throw new VatValidationError(['Reversals require the configured durable transactional store for the same canonical owner scope.'])
    if (!original || !trustedVatPostings.has(original) || original.sourceId !== split.reversalOf || original.reversalOf) throw new VatValidationError(['Reversal requires the exact immutable original VAT posting.'])
    if (!split.originalTaxPoint || original.taxPoint !== split.originalTaxPoint) throw new VatValidationError(['Reversal must explicitly identify the immutable original tax point.'])
    if (split.taxPoint < original.taxPoint) throw new VatValidationError(['Reversal tax point cannot predate the original posting.'])
  } else if (split.originalTaxPoint) throw new VatValidationError(['An original tax point is only valid for a reversal.'])
  const treatmentTaxPoint = split.reversalOf ? split.originalTaxPoint! : split.taxPoint
  const rule = rules.at(split.ruleId, treatmentTaxPoint)
  const direction = split.direction ?? 'sale'
  const recipientAssessed = ['intra-eu', 'import'].includes(rule.case) || (rule.case === 'reverse-charge' && rule.reverseChargeRole === 'recipient')
  if (recipientAssessed && direction !== 'purchase') throw new VatValidationError([`${rule.case} recipient VAT treatment requires a purchase direction.`])
  if (rule.case === 'reverse-charge' && rule.reverseChargeRole === 'supplier' && direction !== 'sale') throw new VatValidationError(['Supplier reverse-charge treatment requires a sale direction.'])
  if (rule.case === 'private-use' && direction !== 'sale') throw new VatValidationError(['Private-use deemed supplies require a sale direction.'])
  if (rule.case === 'intra-eu-supply' && (split.direction !== 'sale' || split.customerType !== 'business' || split.supplyKind !== 'goods' || !split.customerVatId || !split.customerCountry || !isCanonicalTransportEvidence(split.transportEvidence, split.ownerId, split.customerCountry, split.reversalOf ?? split.sourceId) || !isTrustedVatIdValidation(split.customerVatIdValidation, split.customerVatId, split.customerCountry, split.supplyKind, treatmentTaxPoint))) throw new VatValidationError(['Intra-EU zero-rated supply requires outbound goods, owner/source-bound canonical transport evidence, country-specific VAT-ID syntax, and authoritative validation evidence effective at the tax point.'])
  if (rule.case === 'intra-eu-service' && (split.direction !== 'sale' || split.customerType !== 'business' || split.supplyKind !== 'services' || !split.customerVatId || !split.customerCountry || split.customerCountry === 'DE' || split.transportEvidence !== undefined || !isTrustedVatIdValidation(split.customerVatIdValidation, split.customerVatId, split.customerCountry, split.supplyKind, treatmentTaxPoint))) throw new VatValidationError(['Intra-EU B2B services require an outbound service, a foreign business recipient, and authoritative VAT-ID evidence effective at the tax point.'])
  if (rule.case === 'oss-sale' && (split.direction !== 'sale' || split.customerType !== 'consumer' || split.customerCountry !== rule.jurisdiction)) throw new VatValidationError(['OSS rule requires an outbound consumer sale whose destination matches the rule jurisdiction.'])
  const sign = split.reversalOf ? -1 : 1
  const sourceAmount = Math.abs(split.amountCents)
  const chargesVat = !['exempt', 'zero', 'reverse-charge', 'intra-eu', 'intra-eu-supply', 'intra-eu-service', 'import'].includes(rule.case)
  const containedTax = split.mode === 'gross' && chargesVat ? roundProduct(sourceAmount, rule.rateBasisPoints, 10_000 + rule.rateBasisPoints) : 0
  const net = split.mode === 'gross' && chargesVat ? sourceAmount - containedTax : sourceAmount
  const chargedTax = !chargesVat ? 0 : split.mode === 'gross' ? containedTax : roundProduct(net, rule.rateBasisPoints, 10_000)
  const assessedTax = roundProduct(net, rule.rateBasisPoints, 10_000)
  const tax = recipientAssessed ? assessedTax : chargedTax
  const output = recipientAssessed && rule.case !== 'import' || rule.case === 'private-use' ? assessedTax : direction === 'purchase' || rule.case === 'import' ? 0 : chargedTax
  const deductibleBase = recipientAssessed ? assessedTax : direction === 'purchase' ? chargedTax : 0
  const deductible = roundProduct(deductibleBase, rule.deductibleShareBasisPoints, 10_000)
  const gross = split.mode === 'gross' ? sourceAmount : net + chargedTax
  if (![net, chargedTax, assessedTax, tax, output, deductible, gross].every(Number.isSafeInteger)) throw new VatValidationError(['Calculated VAT monetary values exceed safe integer cents.'])
  const detail = deepFreeze({
    ...projectVatSourceSplit(split), amountCents: split.amountCents * sign, jurisdiction: rule.jurisdiction, ruleVersion: rule.version, case: rule.case,
    rateBasisPoints: rule.rateBasisPoints, netBaseCents: net * sign, taxCents: tax * sign,
    deductibleTaxCents: deductible * sign, grossCents: gross * sign, outputTaxCents: output * sign,
    inputTaxCents: deductible * sign, returnBoxes: Object.freeze(rule.returnBoxes.filter(box => !box.direction || box.direction === direction).map(box => Object.freeze({ ...box }))), reason: rule.reason,
  }) as VatPostingDetail
  let consumedOriginal: { sourceId: string; identity: string } | undefined
  if (split.reversalOf) {
    const immutableOriginal = original as VatPostingDetail
    const exact = immutableOriginal.ownerId === split.ownerId && immutableOriginal.amountCents === split.amountCents && immutableOriginal.mode === split.mode && immutableOriginal.ruleId === split.ruleId && immutableOriginal.taxPoint === split.originalTaxPoint && (immutableOriginal.direction ?? 'sale') === direction && immutableOriginal.customerVatId === split.customerVatId && immutableOriginal.customerCountry === split.customerCountry && immutableOriginal.customerType === split.customerType && immutableOriginal.customerVatIdValidation === split.customerVatIdValidation && immutableOriginal.supplyKind === split.supplyKind && JSON.stringify(immutableOriginal.transportEvidence) === JSON.stringify(split.transportEvidence) && immutableOriginal.jurisdiction === rule.jurisdiction && immutableOriginal.case === rule.case && immutableOriginal.reason === rule.reason && immutableOriginal.ruleVersion === rule.version && immutableOriginal.rateBasisPoints === rule.rateBasisPoints && immutableOriginal.netBaseCents === net && immutableOriginal.taxCents === tax && immutableOriginal.deductibleTaxCents === deductible && immutableOriginal.grossCents === gross && immutableOriginal.outputTaxCents === output && immutableOriginal.inputTaxCents === deductible && JSON.stringify(immutableOriginal.returnBoxes) === JSON.stringify(detail.returnBoxes)
    if (!exact) throw new VatValidationError(['Reversal amount, rule, rate, direction and tax must exactly match the immutable original VAT posting.'])
    consumedOriginal = { sourceId: immutableOriginal.sourceId, identity: postingIdentity(immutableOriginal) }
    if (pendingReversals) pendingReversals.push(consumedOriginal)
  }
  if (trustedVatRuleBooks.has(rules)) {
    trustedVatPostings.add(detail)
    if (reversalRegistry) {
      if (pendingOriginals) pendingOriginals.push(detail)
      else if (consumedOriginal) reversalRegistry.commitBatch([detail], [consumedOriginal], VAT_POSTING_CAPABILITY)
      else reversalRegistry.registerOriginal(detail, VAT_POSTING_CAPABILITY)
    }
  }
  return detail
}

export function calculateMixedVat(splits: readonly VatSourceSplit[], rules: VatRuleBook, originals: readonly VatPostingDetail[] = [], reversalRegistry?: VatReversalRegistry): VatPostingDetail[] {
  if (new Set(splits.map(split => split.sourceId)).size !== splits.length) throw new VatValidationError(['Every mixed-rate source split needs a unique source ID.'])
  if (new Set(splits.map(split => split.ownerId)).size > 1) throw new VatValidationError(['Every mixed-rate batch must belong to one canonical owner scope.'])
  const reversalTargets = splits.flatMap(split => split.reversalOf ? [split.reversalOf] : [])
  if (new Set(reversalTargets).size !== reversalTargets.length) throw new VatValidationError(['A VAT posting may be reversed only once in a mixed calculation batch.'])
  const hasReversals = splits.some(split => split.reversalOf)
  if (hasReversals && !reversalRegistry) throw new VatValidationError(['Mixed reversals require an explicit durable owner-scoped registry.'])
  const pendingReversals: { sourceId: string; identity: string }[] = []; const pendingOriginals: VatPostingDetail[] = []; const available = [...originals]; const result: VatPostingDetail[] = []
  for (const split of splits) { const detail = calculateVatInternal(split, rules, split.reversalOf ? available.find(item => item.sourceId === split.reversalOf) : undefined, reversalRegistry, pendingReversals, pendingOriginals); result.push(detail); available.push(detail) }
  if (reversalRegistry && (pendingReversals.length || pendingOriginals.length)) reversalRegistry.commitBatch(pendingOriginals, pendingReversals, VAT_POSTING_CAPABILITY)
  return result
}
export function attachVatDocument(posting: VatPostingDetail, documentId: string): VatPostingDetail & { documentId: string } { if (!trustedVatPostings.has(posting) || !documentId.trim()) throw new VatValidationError(['Document provenance can only be attached to an exact trusted VAT posting.']); const attached = deepFreeze({ ...posting, documentId }) as VatPostingDetail & { documentId: string }; trustedVatPostings.add(attached); return attached }

export interface VatLedgerControl { outputTaxCents: number; inputTaxCents: number }
export interface VatReturnBox { box: string; amountCents: number; entryIds: readonly string[]; documentIds: readonly string[] }
export interface VatReconciliation { ownerId: string; ok: boolean; expected: VatLedgerControl; ledger: VatLedgerControl; boxes: readonly VatReturnBox[]; discrepancies: readonly string[]; toleranceCents: number }

export function reconcileVat(details: readonly (VatPostingDetail & { documentId?: string })[], ledger: VatLedgerControl, toleranceCents = 0, ownerId = details[0]?.ownerId): VatReconciliation {
  const monetaryKeys = ['amountCents', 'netBaseCents', 'taxCents', 'deductibleTaxCents', 'grossCents', 'outputTaxCents', 'inputTaxCents'] as const
  if (details.some(detail => monetaryKeys.some(key => !Number.isSafeInteger(detail[key])))) throw new VatValidationError(['Every VAT posting monetary field must be finite safe integer cents.'])
  if (details.some(detail => !detail.sourceId.trim() || (detail.documentId !== undefined && !detail.documentId.trim())) || new Set(details.map(detail => detail.sourceId)).size !== details.length) throw new VatValidationError(['VAT reconciliation requires unique nonblank posting source IDs and nonblank document provenance.'])
  if (details.some(detail => !trustedVatPostings.has(detail))) throw new VatValidationError(['VAT reconciliation requires exact trusted calculated posting instances.'])
  if (!ownerId?.trim() || details.some(detail => detail.ownerId !== ownerId)) throw new VatValidationError(['VAT reconciliation requires one canonical owner shared by every posting.'])
  if (!Number.isSafeInteger(ledger.outputTaxCents) || !Number.isSafeInteger(ledger.inputTaxCents)) throw new VatValidationError(['VAT ledger controls must be finite integer cents within the safe range.'])
  if (!Number.isSafeInteger(toleranceCents) || toleranceCents < 0) throw new VatValidationError(['VAT reconciliation tolerance must be a non-negative safe-integer number of cents.'])
  const expected = { outputTaxCents: safeCents(sumBigInt(details, 'outputTaxCents'), 'VAT output aggregate'), inputTaxCents: safeCents(sumBigInt(details, 'inputTaxCents'), 'VAT input aggregate') }
  const grouped = new Map<string, { amountCents: bigint; entryIds: string[]; documentIds: string[] }>()
  for (const detail of details) for (const mapping of detail.returnBoxes) {
    const current = grouped.get(mapping.box) ?? { amountCents: BigInt(0), entryIds: [], documentIds: [] }
    current.amountCents += BigInt(mapping.value === 'net-base' ? detail.netBaseCents : mapping.value === 'input-tax' ? detail.inputTaxCents : detail.outputTaxCents)
    current.entryIds.push(detail.sourceId)
    if (detail.documentId) current.documentIds.push(detail.documentId)
    grouped.set(mapping.box, current)
  }
  const discrepancies: string[] = []
  const outputDifference = BigInt(ledger.outputTaxCents) - BigInt(expected.outputTaxCents)
  const inputDifference = BigInt(ledger.inputTaxCents) - BigInt(expected.inputTaxCents)
  if (absolute(outputDifference) > BigInt(toleranceCents)) discrepancies.push(`Output VAT control differs by ${outputDifference} cents.`)
  if (absolute(inputDifference) > BigInt(toleranceCents)) discrepancies.push(`Input VAT control differs by ${inputDifference} cents.`)
  const boxes = [...grouped].map(([box, value]) => ({ box, amountCents: safeCents(value.amountCents, `VAT return box ${box}`), entryIds: Object.freeze(value.entryIds), documentIds: Object.freeze(value.documentIds) }))
  return deepFreeze({ ownerId, ok: discrepancies.length === 0, expected, ledger: { ...ledger }, boxes, discrepancies, toleranceCents }) as VatReconciliation
}

export function requireVatReconciliation(result: VatReconciliation): void { if (!result.ok) throw new VatValidationError(result.discrepancies) }
function roundProduct(value: number, multiplier: number, denominator: number) { const result = (BigInt(value) * BigInt(multiplier) + BigInt(Math.floor(denominator / 2))) / BigInt(denominator); const number = Number(result); if (!Number.isSafeInteger(number)) throw new VatValidationError(['Calculated VAT monetary values exceed safe integer cents.']); return number }
function absolute(value: bigint) { return value < BigInt(0) ? -value : value }
function overlaps(a: VatRule, b: VatRule) { return a.validFrom <= (b.validTo ?? '9999-12-31') && b.validFrom <= (a.validTo ?? '9999-12-31') }
function sumBigInt(details: readonly VatPostingDetail[], key: 'outputTaxCents' | 'inputTaxCents') { return details.reduce((total, detail) => total + BigInt(detail[key]), BigInt(0)) }
function safeCents(value: bigint, label: string) { const number = Number(value); if (!Number.isSafeInteger(number)) throw new VatValidationError([`${label} exceeds safe integer cents.`]); return number }
function postingIdentity(posting: VatPostingDetail) { return canonicalPostingJson([posting.ownerId, posting.sourceId, posting.amountCents, posting.mode, posting.taxPoint, posting.ruleId, posting.direction ?? 'sale', posting.reversalOf ?? null, posting.originalTaxPoint ?? null, posting.customerVatId ?? null, posting.customerCountry ?? null, posting.customerType ?? null, posting.customerVatIdValidation ?? null, posting.supplyKind ?? null, posting.transportEvidence ?? null, posting.jurisdiction, posting.ruleVersion, posting.case, posting.rateBasisPoints, posting.netBaseCents, posting.taxCents, posting.deductibleTaxCents, posting.grossCents, posting.outputTaxCents, posting.inputTaxCents, posting.returnBoxes, posting.reason]) }
function projectVatSourceSplit(split: VatSourceSplit): VatSourceSplit { return { ownerId: split.ownerId, sourceId: split.sourceId, amountCents: split.amountCents, mode: split.mode, taxPoint: split.taxPoint, ruleId: split.ruleId, ...(split.direction !== undefined ? { direction: split.direction } : {}), ...(split.reversalOf !== undefined ? { reversalOf: split.reversalOf } : {}), ...(split.originalTaxPoint !== undefined ? { originalTaxPoint: split.originalTaxPoint } : {}), ...(split.customerVatId !== undefined ? { customerVatId: split.customerVatId } : {}), ...(split.customerCountry !== undefined ? { customerCountry: split.customerCountry } : {}), ...(split.customerType !== undefined ? { customerType: split.customerType } : {}), ...(split.customerVatIdValidation !== undefined ? { customerVatIdValidation: split.customerVatIdValidation } : {}), ...(split.supplyKind !== undefined ? { supplyKind: split.supplyKind } : {}), ...(split.transportEvidence !== undefined ? { transportEvidence: split.transportEvidence } : {}) } }
function canonicalPostingJson(value: unknown): string { if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(item => canonicalPostingJson(item === undefined ? null : item)).join(',')}]`; if (value && typeof value === 'object') { const record = value as Record<string, unknown>; return `{${Object.keys(record).filter(key => record[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalPostingJson(record[key])}`).join(',')}}` } throw new VatValidationError(['VAT posting identity contains an unsupported canonical value.']) }
function isRealDate(value: string) { if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const date = new Date(`${value}T00:00:00Z`); return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value }
function isVatIdValidationEffectiveAt(validatedAt: string, taxPoint: string) { if (!isCanonicalInstant(validatedAt) || !isRealDate(taxPoint)) return false; const validationDate = validatedAt.slice(0, 10); if (validationDate > taxPoint) return false; const ageDays = (Date.parse(`${taxPoint}T00:00:00Z`) - Date.parse(`${validationDate}T00:00:00Z`)) / 86_400_000; return ageDays <= 90 }
function matchesCountryVatId(vat: string, country: string, supplyKind: 'goods' | 'services') { const code = country === 'GR' ? 'EL' : country; if (code === 'XI' && supplyKind !== 'goods') return false; const patterns: Record<string, RegExp> = { AT: /^ATU\d{8}$/, BE: /^BE0?\d{9}$/, BG: /^BG\d{9,10}$/, CY: /^CY\d{8}[A-Z]$/, CZ: /^CZ\d{8,10}$/, DK: /^DK\d{8}$/, EE: /^EE\d{9}$/, EL: /^EL\d{9}$/, ES: /^ES[A-Z0-9]\d{7}[A-Z0-9]$/, FI: /^FI\d{8}$/, FR: /^FR[A-Z0-9]{2}\d{9}$/, HR: /^HR\d{11}$/, HU: /^HU\d{8}$/, IE: /^IE[A-Z0-9]{8,9}$/, IT: /^IT\d{11}$/, LT: /^LT(?:\d{9}|\d{12})$/, LU: /^LU\d{8}$/, LV: /^LV\d{11}$/, MT: /^MT\d{8}$/, NL: /^NL[A-Z0-9]{9}B\d{2}$/, PL: /^PL\d{10}$/, PT: /^PT\d{9}$/, RO: /^RO\d{2,10}$/, SE: /^SE\d{12}$/, SI: /^SI\d{8}$/, SK: /^SK\d{10}$/, XI: /^XI(?:\d{9}|\d{12}|GD\d{3}|HA\d{3})$/ }; return Boolean(patterns[code]?.test(vat)) }
function isCanonicalTransportClaim(evidence: VatTransportEvidenceClaim | undefined, country?: string) { const eligible = new Set(['AT','BE','BG','CY','CZ','DK','EE','EL','ES','FI','FR','HR','HU','IE','IT','LT','LU','LV','MT','NL','PL','PT','RO','SE','SI','SK','XI']); return Boolean(evidence && ['dispatch-document', 'carrier-document'].includes(evidence.type) && country && evidence.ownerId.trim() && evidence.reference.trim() && evidence.sourceId.trim() && evidence.dispatchedFromCountry === 'DE' && evidence.destinationCountry === country && country !== 'DE' && eligible.has(country === 'GR' ? 'EL' : country) && Object.keys(evidence).sort().join(',') === 'destinationCountry,dispatchedFromCountry,ownerId,reference,sourceId,type') }
function isCanonicalTransportEvidence(evidence: VatTransportEvidence | undefined, ownerId?: string, country?: string, sourceId?: string) { if (!evidence || !trustedTransportEvidence.has(evidence) || evidence.ownerId !== ownerId || evidence.sourceId !== sourceId || !evidence.provider.trim() || !evidence.verificationId.trim() || !isCanonicalInstant(evidence.verifiedAt)) return false; const claim: VatTransportEvidenceClaim = { ownerId: evidence.ownerId, type: evidence.type, reference: evidence.reference, dispatchedFromCountry: evidence.dispatchedFromCountry, destinationCountry: evidence.destinationCountry, sourceId: evidence.sourceId }; return isCanonicalTransportClaim(claim, country) && Object.keys(evidence).sort().join(',') === 'destinationCountry,dispatchedFromCountry,ownerId,provider,reference,sourceId,type,verificationId,verifiedAt' }
function isCanonicalInstant(value: unknown): value is string { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false; const normalized = value.includes('.') ? value : value.replace(/Z$/, '.000Z'); const parsed = new Date(value); return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === normalized }
function deepFreeze<T>(value: T): Readonly<T> { if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(deepFreeze) } return value }

export const representativeGermanVatRules: readonly VatRule[] = Object.freeze([
  { id: 'DE_STANDARD', version: 1, validFrom: '2007-01-01', jurisdiction: 'DE', case: 'standard', rateBasisPoints: 1900, deductibleShareBasisPoints: 10_000, outputAccount: '1776', inputAccount: '1576', returnBoxes: [{ box: '81', value: 'net-base', direction: 'sale' }, { box: '66', value: 'input-tax', direction: 'purchase' }], reason: 'UStG §12(1)' },
  { id: 'DE_REDUCED', version: 1, validFrom: '2007-01-01', jurisdiction: 'DE', case: 'reduced', rateBasisPoints: 700, deductibleShareBasisPoints: 10_000, outputAccount: '1771', inputAccount: '1571', returnBoxes: [{ box: '86', value: 'net-base', direction: 'sale' }, { box: '66', value: 'input-tax', direction: 'purchase' }], reason: 'UStG §12(2)' },
  { id: 'DE_ZERO', version: 1, validFrom: '2023-01-01', jurisdiction: 'DE', case: 'zero', rateBasisPoints: 0, deductibleShareBasisPoints: 10_000, outputAccount: '1770', returnBoxes: [], reason: 'UStG §12(3)' },
  { id: 'DE_EXEMPT', version: 1, validFrom: '2007-01-01', jurisdiction: 'DE', case: 'exempt', rateBasisPoints: 0, deductibleShareBasisPoints: 0, outputAccount: '1770', returnBoxes: [{ box: '48', value: 'net-base', direction: 'sale' }], reason: 'UStG §4' },
  { id: 'DE_13B', version: 1, validFrom: '2007-01-01', jurisdiction: 'DE', case: 'reverse-charge', reverseChargeRole: 'recipient', rateBasisPoints: 1900, deductibleShareBasisPoints: 10_000, outputAccount: '1787', inputAccount: '1577', returnBoxes: [{ box: '84', value: 'net-base', direction: 'purchase' }, { box: '85', value: 'output-tax', direction: 'purchase' }, { box: '67', value: 'input-tax', direction: 'purchase' }], reason: 'UStG §13b recipient' },
  { id: 'DE_13B_SUPPLIER', version: 1, validFrom: '2007-01-01', jurisdiction: 'DE', case: 'reverse-charge', reverseChargeRole: 'supplier', rateBasisPoints: 1900, deductibleShareBasisPoints: 0, outputAccount: '8337', returnBoxes: [{ box: '60', value: 'net-base', direction: 'sale' }], reason: 'UStG §13b supplier' },
  { id: 'EU_ACQUISITION', version: 1, validFrom: '2007-01-01', jurisdiction: 'DE/EU', case: 'intra-eu', rateBasisPoints: 1900, deductibleShareBasisPoints: 10_000, outputAccount: '1774', inputAccount: '1574', returnBoxes: [{ box: '89', value: 'net-base', direction: 'purchase' }, { box: '93', value: 'output-tax', direction: 'purchase' }, { box: '61', value: 'input-tax', direction: 'purchase' }], reason: 'UStG §1a' },
  { id: 'EU_SUPPLY', version: 1, validFrom: '2007-01-01', jurisdiction: 'EU', case: 'intra-eu-supply', rateBasisPoints: 0, deductibleShareBasisPoints: 0, outputAccount: '8125', returnBoxes: [{ box: '41', value: 'net-base', direction: 'sale' }], reason: 'UStG §4 Nr. 1b' },
  { id: 'EU_SERVICE', version: 1, validFrom: '2010-01-01', jurisdiction: 'EU', case: 'intra-eu-service', rateBasisPoints: 0, deductibleShareBasisPoints: 0, outputAccount: '8336', returnBoxes: [{ box: '21', value: 'net-base', direction: 'sale' }], reason: 'UStG §3a(2)' },
  { id: 'OSS_FR_STANDARD', version: 1, validFrom: '2021-07-01', jurisdiction: 'FR', case: 'oss-sale', rateBasisPoints: 2000, deductibleShareBasisPoints: 0, outputAccount: '1767', returnBoxes: [], reason: 'UStG §18j' },
  { id: 'IMPORT_VAT', version: 1, validFrom: '2007-01-01', jurisdiction: 'DE', case: 'import', rateBasisPoints: 1900, deductibleShareBasisPoints: 10_000, outputAccount: '0', inputAccount: '1588', returnBoxes: [{ box: '62', value: 'input-tax', direction: 'purchase' }], reason: 'UStG §15(1)2' },
  { id: 'DE_DEPOSIT', version: 1, validFrom: '2007-01-01', jurisdiction: 'DE', case: 'deposit', rateBasisPoints: 1900, deductibleShareBasisPoints: 10_000, outputAccount: '1776', inputAccount: '1576', returnBoxes: [{ box: '81', value: 'net-base', direction: 'sale' }, { box: '66', value: 'input-tax', direction: 'purchase' }], reason: 'UStG §13(1)1a' },
  { id: 'DE_FINAL', version: 1, validFrom: '2007-01-01', jurisdiction: 'DE', case: 'final-invoice', rateBasisPoints: 1900, deductibleShareBasisPoints: 10_000, outputAccount: '1776', inputAccount: '1576', returnBoxes: [{ box: '81', value: 'net-base', direction: 'sale' }, { box: '66', value: 'input-tax', direction: 'purchase' }], reason: 'UStDV §31' },
  { id: 'DE_PRIVATE_USE', version: 1, validFrom: '2007-01-01', jurisdiction: 'DE', case: 'private-use', rateBasisPoints: 1900, deductibleShareBasisPoints: 0, outputAccount: '1776', returnBoxes: [{ box: '81', value: 'net-base', direction: 'sale' }], reason: 'UStG §3(9a)' },
])
