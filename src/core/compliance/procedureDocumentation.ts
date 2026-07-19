import { createHash } from 'node:crypto'
import { canonicalJson } from './auditExport'
import { hasDenseNonblankStrings, hasDenseOwnElements, hasStrictEvidenceIds } from './validation'

export const REQUIRED_PROCEDURE_SECTIONS = ['general', 'user', 'technical', 'operations', 'capture', 'posting', 'correction', 'closing', 'archiving', 'reporting', 'interfaces', 'access', 'backup-recovery'] as const
export const REQUIRED_CONTROLS = ['roles-approvals', 'separation-of-duties', 'completeness', 'reconciliation', 'exception-handling', 'control-evidence'] as const
export type ProcedureSection = typeof REQUIRED_PROCEDURE_SECTIONS[number]
export type ProcedureControl = typeof REQUIRED_CONTROLS[number]

export interface ProcedureDocumentVersion {
  id: string; version: string; effectiveFrom: string; effectiveTo?: string; approvedBy: string; approvedAt: string
  appVersion: string; configurationVersion: string; schemaVersion: string; taxonomyVersions: readonly string[]
  sections: Partial<Record<ProcedureSection, string>>; controls: Partial<Record<ProcedureControl, { description: string; ownerRole: string; evidenceReferences: readonly string[] }>>
  changeLog: readonly { changedAt: string; changedBy: string; summary: string }[]
}
export interface TenantProcedureDetails { tenantId: string; legalName: string; operatorRoles: Readonly<Record<string, string>>; procedures: Readonly<Record<string, string>>; evidenceIndex: readonly string[] }
export interface TenantProcedureSnapshot { id: string; effectiveFrom: string; effectiveTo?: string; details: TenantProcedureDetails }
export interface ProcedurePackage { manifest: { format: 'verfahrensdokumentation'; version: 1; documentId: string; documentVersion: string; tenantId: string; generatedAt: string; checksum: string; tenantSnapshotId?: string }; content: string; warnings: readonly string[] }

export function validateProcedureVersion(document: ProcedureDocumentVersion): string[] {
  const issues: string[] = []
  if (!isRecord(document)) return ['Procedure document must be a structured object.']
  const candidate = document as unknown as Record<string, unknown>
  const id = ownEnumerableDataValue(candidate, 'id')
  if (typeof id !== 'string' || !id.trim()) issues.push('Procedure document ID must be nonblank and stable.')
  if (!validEffectiveBoundaries(candidate)) issues.push('Procedure effective boundaries are invalid or reversed.')
  const sectionValue = ownEnumerableDataValue(candidate, 'sections'); const controlValue = ownEnumerableDataValue(candidate, 'controls')
  const sections = isRecord(sectionValue) ? sectionValue : {}
  const controls = isRecord(controlValue) ? controlValue : {}
  for (const section of REQUIRED_PROCEDURE_SECTIONS) { const value = ownEnumerableDataValue(sections, section); if (typeof value !== 'string' || !value.trim()) issues.push(`Missing required section: ${section}`) }
  for (const control of REQUIRED_CONTROLS) {
    const value = ownEnumerableDataValue(controls, control)
    if (!isRecord(value) || typeof ownEnumerableDataValue(value, 'description') !== 'string' || !(ownEnumerableDataValue(value, 'description') as string).trim() || typeof ownEnumerableDataValue(value, 'ownerRole') !== 'string' || !(ownEnumerableDataValue(value, 'ownerRole') as string).trim()) issues.push(`Incomplete required control: ${control}`)
    else if (!hasStrictEvidenceIds(ownEnumerableDataValue(value, 'evidenceReferences'))) issues.push(`Control has no evidence: ${control}`)
  }
  const version = ownEnumerableDataValue(candidate, 'version'); const approvedBy = ownEnumerableDataValue(candidate, 'approvedBy'); const approvedAt = ownEnumerableDataValue(candidate, 'approvedAt')
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) issues.push('Document version must use semantic versioning.')
  if (typeof approvedBy !== 'string' || !approvedBy.trim() || !validInstant(approvedAt)) issues.push('Approval identity and real timestamp are required.')
  for (const [label, field] of [['app', 'appVersion'], ['configuration', 'configurationVersion'], ['schema', 'schemaVersion']] as const) { const componentVersion = ownEnumerableDataValue(candidate, field); if (typeof componentVersion !== 'string' || !componentVersion.trim()) issues.push(`Missing ${label} version.`) }
  if (!hasDenseNonblankStrings(ownEnumerableDataValue(candidate, 'taxonomyVersions'))) issues.push('At least one nonblank taxonomy version is required.')
  const changeLog = ownEnumerableDataValue(candidate, 'changeLog')
  const capturedChangeLog = snapshotDenseArray(changeLog)
  if (!capturedChangeLog || capturedChangeLog.length === 0 || capturedChangeLog.some(entry => !isRecord(entry) || !validChangeLogEntry(entry))) issues.push('At least one well-formed change-log entry with date, actor and summary is required.')
  return issues
}

export function selectHistoricProcedure(versions: readonly ProcedureDocumentVersion[], at: string) {
  const capturedVersions = snapshotDenseArray<ProcedureDocumentVersion>(versions); if (!capturedVersions) throw new Error('Procedure versions must be an array.')
  if (!validInstant(at)) throw new Error('Historic package date is invalid.'); const instant = Date.parse(at)
  const normalizedVersions = capturedVersions.map(version => { if (!validEffectiveBoundaries(version)) throw new Error('Procedure effective boundaries are invalid or reversed.'); return normalizeProcedureDocument(version) })
  const documentIds = new Set(normalizedVersions.map(version => version.id)); if (normalizedVersions.length && (documentIds.size !== 1 || [...documentIds].some(id => !id.trim() || id !== id.trim()))) throw new Error('Procedure version history must belong to one canonical nonblank document ID.')
  const versionIds = normalizedVersions.map(version => version.version); if (new Set(versionIds).size !== versionIds.length || versionIds.some(version => !version.trim() || version !== version.trim())) throw new Error('Procedure version history requires unique canonical version identities.')
  const matches = normalizedVersions.filter(version => boundaryStart(version.effectiveFrom) <= instant && instant <= boundaryEnd(version.effectiveTo))
  if (matches.length !== 1) throw new Error(matches.length ? 'Procedure versions overlap.' : 'No procedure version was effective at that date.')
  return matches[0]
}

export function createTenantProcedurePackage(document: ProcedureDocumentVersion, tenant: TenantProcedureDetails, generatedAt: string): ProcedurePackage {
  return buildTenantProcedurePackage(document, tenant, generatedAt)
}

function buildTenantProcedurePackage(document: ProcedureDocumentVersion, tenant: TenantProcedureDetails, generatedAt: string, tenantSnapshot?: TenantProcedureSnapshot): ProcedurePackage {
  if (!isRecord(document)) throw new Error('Procedure document must be a structured object.')
  if (!isRecord(tenant)) throw new Error('Tenant procedure details must be a structured object.')
  const normalizedDocument = normalizeProcedureDocument(document); const normalizedTenant = normalizeTenantProcedureDetails(tenant)
  if (!normalizedTenant.tenantId.trim() || !normalizedTenant.legalName.trim()) throw new Error('Tenant identity is required.')
  if (!validInstant(generatedAt)) throw new Error('Procedure package generation timestamp is invalid.')
  if (!validEffectiveBoundaries(document)) throw new Error('Procedure effective boundaries are invalid or reversed.')
  const generated = Date.parse(generatedAt); if (generated < boundaryStart(normalizedDocument.effectiveFrom) || generated > boundaryEnd(normalizedDocument.effectiveTo)) throw new Error('Procedure package generation is outside the document effective interval.'); if (!validInstant(normalizedDocument.approvedAt) || generated < Date.parse(normalizedDocument.approvedAt)) throw new Error('Procedure package generation cannot predate document approval.')
  const warnings = validateProcedureVersion(document)
  const procedures = normalizedTenant.procedures
  for (const required of ['capture', 'posting', 'closing', 'backup-recovery']) { const value = ownEnumerableDataValue(procedures, required); if (typeof value !== 'string' || !value.trim()) warnings.push(`Tenant procedure is incomplete: ${required}`) }
  const operatorRoles = Object.entries(normalizedTenant.operatorRoles)
  if (operatorRoles.length === 0 || operatorRoles.some(([role, identity]) => !role.trim() || typeof identity !== 'string' || !identity.trim())) warnings.push('Tenant operator roles require at least one nonblank role with an assigned operator.')
  if (!hasStrictEvidenceIds(normalizedTenant.evidenceIndex)) warnings.push('Tenant evidence index requires at least one nonblank evidence reference.')
  else { const indexedEvidence = new Set(normalizedTenant.evidenceIndex); const controls = normalizedDocument.controls; for (const control of REQUIRED_CONTROLS) { const value = controls[control]; const references = value?.evidenceReferences; if (hasStrictEvidenceIds(references) && references.some(reference => !indexedEvidence.has(reference))) warnings.push(`Tenant evidence index is missing required control evidence: ${control}`) } }
  const product = normalizedDocument
  const operatorSnapshot = tenantSnapshot ? { id: tenantSnapshot.id, effectiveFrom: tenantSnapshot.effectiveFrom, ...(tenantSnapshot.effectiveTo === undefined ? {} : { effectiveTo: tenantSnapshot.effectiveTo }) } : undefined
  const body = { product, operator: normalizedTenant, ...(operatorSnapshot ? { operatorSnapshot } : {}), completeness: { complete: warnings.length === 0, warnings } }
  const content = canonicalJson(body); const checksum = createHash('sha256').update(content).digest('hex')
  return { manifest: { format: 'verfahrensdokumentation', version: 1, documentId: normalizedDocument.id, documentVersion: normalizedDocument.version, tenantId: normalizedTenant.tenantId, generatedAt, checksum, ...(tenantSnapshot ? { tenantSnapshotId: tenantSnapshot.id } : {}) }, content, warnings }
}

export function selectHistoricTenantProcedureSnapshot(snapshots: readonly TenantProcedureSnapshot[], at: string): TenantProcedureSnapshot {
  const capturedSnapshots = snapshotDenseArray<TenantProcedureSnapshot>(snapshots); if (!capturedSnapshots) throw new Error('Tenant procedure snapshots must be an array.')
  if (!validInstant(at)) throw new Error('Historic tenant snapshot date is invalid.')
  const normalizedSnapshots = capturedSnapshots.map(normalizeTenantProcedureSnapshot)
  const tenantIds = new Set(normalizedSnapshots.map(snapshot => snapshot.details.tenantId))
  if (tenantIds.size > 1) throw new Error('Tenant procedure snapshot history must belong to one authoritative tenant.')
  const snapshotIds = normalizedSnapshots.map(snapshot => snapshot.id); if (new Set(snapshotIds).size !== snapshotIds.length || snapshotIds.some(id => id !== id.trim())) throw new Error('Tenant procedure snapshot history requires unique canonical nonblank IDs.')
  const instant = Date.parse(at)
  const matches = normalizedSnapshots.filter(snapshot => boundaryStart(snapshot.effectiveFrom) <= instant && instant <= boundaryEnd(snapshot.effectiveTo))
  if (matches.length !== 1) throw new Error(matches.length ? 'Tenant procedure snapshots overlap.' : 'No tenant procedure snapshot was effective at that date.')
  return matches[0]
}

export function reproduceHistoricPackage(versions: readonly ProcedureDocumentVersion[], tenantSnapshots: readonly TenantProcedureSnapshot[], historicGeneratedAt: string) {
  const document = selectHistoricProcedure(versions, historicGeneratedAt)
  const tenantSnapshot = selectHistoricTenantProcedureSnapshot(tenantSnapshots, historicGeneratedAt)
  return buildTenantProcedurePackage(document, tenantSnapshot.details, historicGeneratedAt, tenantSnapshot)
}
function validDateOnly(value: unknown): value is string { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const parsed = new Date(`${value}T00:00:00.000Z`); return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value }
function validInstant(value: unknown): value is string { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && validDateOnly(value.slice(0, 10)) && !Number.isNaN(Date.parse(value)) }
function validDateBoundary(value: unknown): value is string { return validDateOnly(value) || validInstant(value) }
function validEffectiveBoundaries(document: unknown) { if (!isRecord(document)) return false; const effectiveFrom = ownEnumerableDataValue(document, 'effectiveFrom'); const effectiveToDescriptor = Object.getOwnPropertyDescriptor(document, 'effectiveTo'); const hasEffectiveTo = 'effectiveTo' in document; if (!validDateBoundary(effectiveFrom) || (hasEffectiveTo && (!effectiveToDescriptor?.enumerable || !Object.hasOwn(effectiveToDescriptor, 'value')))) return false; const effectiveTo = effectiveToDescriptor?.value; return effectiveTo === undefined || (validDateBoundary(effectiveTo) && boundaryEnd(effectiveTo) >= boundaryStart(effectiveFrom)) }
function validTenantProcedureDetails(value: unknown): value is TenantProcedureDetails { if (!isRecord(value)) return false; const tenantId = ownEnumerableDataValue(value, 'tenantId'); const legalName = ownEnumerableDataValue(value, 'legalName'); return typeof tenantId === 'string' && Boolean(tenantId.trim()) && typeof legalName === 'string' && Boolean(legalName.trim()) && isRecord(ownEnumerableDataValue(value, 'operatorRoles')) && isRecord(ownEnumerableDataValue(value, 'procedures')) && hasDenseOwnElements(ownEnumerableDataValue(value, 'evidenceIndex')) }
function normalizeTenantProcedureSnapshot(value: unknown): TenantProcedureSnapshot { const snapshot = captureProcedureRecord(value, ['id', 'effectiveFrom', 'details'], ['effectiveTo']); if (!snapshot || !validEffectiveBoundaries(snapshot)) throw new Error('Tenant procedure snapshots require stable IDs, valid effective boundaries and structured tenant state.'); const { id, effectiveFrom, effectiveTo, details } = snapshot; if (typeof id !== 'string' || !id.trim() || typeof effectiveFrom !== 'string' || !validTenantProcedureDetails(details)) throw new Error('Tenant procedure snapshots require stable IDs, valid effective boundaries and structured tenant state.'); return { id, effectiveFrom, ...(typeof effectiveTo === 'string' ? { effectiveTo } : {}), details: normalizeTenantProcedureDetails(details) } }
function captureProcedureRecord(value: unknown, required: readonly string[], optional: readonly string[]) { if (!isRecord(value)) return null; const snapshot: Record<string, unknown> = {}; for (const field of required) { const descriptor = Object.getOwnPropertyDescriptor(value, field); if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null; snapshot[field] = descriptor.value } for (const field of optional) { const descriptor = Object.getOwnPropertyDescriptor(value, field); if (!descriptor) { if (field in value) return null; continue } if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null; if (descriptor.value !== undefined) snapshot[field] = descriptor.value } return snapshot }
function boundaryStart(value: string) { return Date.parse(validDateOnly(value) ? `${value}T00:00:00.000Z` : value) }
function boundaryEnd(value?: string) { if (!value) return Number.POSITIVE_INFINITY; return Date.parse(validDateOnly(value) ? `${value}T23:59:59.999Z` : value) }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function ownEnumerableDataValue(record: Record<string, unknown>, field: string): unknown { const descriptor = Object.getOwnPropertyDescriptor(record, field); return descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined }
function validChangeLogEntry(entry: Record<string, unknown>) { const changedAt = ownEnumerableDataValue(entry, 'changedAt'); const changedBy = ownEnumerableDataValue(entry, 'changedBy'); const summary = ownEnumerableDataValue(entry, 'summary'); return validDateBoundary(changedAt) && typeof changedBy === 'string' && Boolean(changedBy.trim()) && typeof summary === 'string' && Boolean(summary.trim()) }
function normalizeProcedureDocument(document: ProcedureDocumentVersion): ProcedureDocumentVersion { const candidate = document as unknown as Record<string, unknown>; const sectionsSource = ownEnumerableDataValue(candidate, 'sections'); const controlsSource = ownEnumerableDataValue(candidate, 'controls'); const sections: Partial<Record<ProcedureSection, string>> = {}; const controls: ProcedureDocumentVersion['controls'] = {}; if (isRecord(sectionsSource)) for (const section of REQUIRED_PROCEDURE_SECTIONS) { const value = ownEnumerableDataValue(sectionsSource, section); if (typeof value === 'string') sections[section] = value } if (isRecord(controlsSource)) for (const control of REQUIRED_CONTROLS) { const value = ownEnumerableDataValue(controlsSource, control); if (!isRecord(value)) continue; const description = ownEnumerableDataValue(value, 'description'); const ownerRole = ownEnumerableDataValue(value, 'ownerRole'); const evidenceReferences = ownEnumerableDataValue(value, 'evidenceReferences'); controls[control] = { description: typeof description === 'string' ? description : '', ownerRole: typeof ownerRole === 'string' ? ownerRole : '', evidenceReferences: hasStrictEvidenceIds(evidenceReferences) ? snapshotDenseArray<string>(evidenceReferences)! : [] } } const taxonomyVersions = ownEnumerableDataValue(candidate, 'taxonomyVersions'); const changeLog = ownEnumerableDataValue(candidate, 'changeLog'); const capturedChangeLog = snapshotDenseArray(changeLog); const effectiveTo = ownEnumerableDataValue(candidate, 'effectiveTo'); return { id: stringOwn(candidate, 'id'), version: stringOwn(candidate, 'version'), effectiveFrom: stringOwn(candidate, 'effectiveFrom'), ...(typeof effectiveTo === 'string' ? { effectiveTo } : {}), approvedBy: stringOwn(candidate, 'approvedBy'), approvedAt: stringOwn(candidate, 'approvedAt'), appVersion: stringOwn(candidate, 'appVersion'), configurationVersion: stringOwn(candidate, 'configurationVersion'), schemaVersion: stringOwn(candidate, 'schemaVersion'), taxonomyVersions: hasDenseNonblankStrings(taxonomyVersions) ? snapshotDenseArray<string>(taxonomyVersions)! : [], sections, controls, changeLog: capturedChangeLog ? capturedChangeLog.map(entry => isRecord(entry) ? { changedAt: stringOwn(entry, 'changedAt'), changedBy: stringOwn(entry, 'changedBy'), summary: stringOwn(entry, 'summary') } : { changedAt: '', changedBy: '', summary: '' }) : [] } }
function stringOwn(record: Record<string, unknown>, field: string) { const value = ownEnumerableDataValue(record, field); return typeof value === 'string' ? value : '' }
function normalizeTenantProcedureDetails(tenant: TenantProcedureDetails): TenantProcedureDetails { const candidate = tenant as unknown as Record<string, unknown>; const operatorRoles = ownEnumerableDataValue(candidate, 'operatorRoles'); const procedures = ownEnumerableDataValue(candidate, 'procedures'); const evidenceIndex = ownEnumerableDataValue(candidate, 'evidenceIndex'); return { tenantId: stringOwn(candidate, 'tenantId'), legalName: stringOwn(candidate, 'legalName'), operatorRoles: normalizeStringRecord(operatorRoles), procedures: normalizeStringRecord(procedures), evidenceIndex: hasStrictEvidenceIds(evidenceIndex) ? snapshotDenseArray<string>(evidenceIndex)! : [] } }
function normalizeStringRecord(value: unknown): Record<string, string> { if (!isRecord(value)) return {}; const normalized: Record<string, string> = {}; for (const key of Object.keys(value)) { const nested = ownEnumerableDataValue(value, key); if (typeof nested === 'string') normalized[key] = nested } return normalized }
function snapshotDenseArray<T = unknown>(value: unknown): T[] | null { if (!hasDenseOwnElements(value)) return null; const snapshot: T[] = []; for (let index = 0; index < value.length; index++) snapshot.push(Object.getOwnPropertyDescriptor(value, String(index))!.value as T); return snapshot }
