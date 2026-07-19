import 'server-only'

import { randomUUID } from 'node:crypto'
import { prisma } from '@/server/persistence/client'
import { getDocumentStorage } from '@/server/storage'
import { getAuthoritativeStorageRegion } from '@/server/storage/config'
import { AccountingValidationError, validateJournalEntry } from '@/core/doubleEntry'
import { postJournalCorrection, postJournalEntry, resolveCorrectionEntryDate } from '@/server/ledger'
import { appendAuditEvent, verifyAuditChain } from './auditPersistence'
import { deriveReportApplicability, profilePayloadWithConfirmedAddress, profilesSemanticallyEqual, upgradeProfileRegisteredAddress, validateCompanyProfile, validateVersionedCompanyProfile, type CompanyProfile } from './companyProfile'
import { matchesCloseGeneration, validateFiscalPeriods, validateReferenceYearOrder, validateReopenTopology } from './fiscalPeriods'
import { assertRecoveryObjectives, backupMatchesManifest, createBackup, resolveBackupKey, restoreBackup, retentionDeadline, sha256, type EncryptedBackup, type RetentionClass } from './retention'
import { validateMappings, type AccountMapping } from './chartLifecycle'
import { persistComplianceObject } from './objectStorage'
import { excludeBackupPayloadLocators, exerciseIsolatedObjectRestore, snapshotStorageReferences, verifyRestoredStorageObjects, verifySnapshotInIsolatedDatabase, type TenantBackupSnapshot } from './restoreVerification'

export class ComplianceRuntimeError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

export async function authorizeComplianceTenant(actorId: string, requestedOwnerId?: unknown): Promise<string> {
  const ownerId = typeof requestedOwnerId === 'string' && requestedOwnerId.trim() ? requestedOwnerId.trim() : actorId
  if (ownerId === actorId) return ownerId
  const policy = await prisma.compliancePolicy.findUnique({ where: { ownerId }, select: { operatorIds: true } })
  const operators = policy ? JSON.parse(policy.operatorIds) as unknown[] : []
  if (!operators.includes(actorId)) throw new ComplianceRuntimeError('The authenticated user is not an operator for this tenant', 403)
  return ownerId
}

const dateOnly = (value: Date) => value.toISOString().slice(0, 10)
const endOfDay = (value: string) => new Date(`${value}T23:59:59.999Z`)
const startOfDay = (value: string) => new Date(`${value}T00:00:00.000Z`)
const requireIsoDate = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ComplianceRuntimeError(`${label} must be a real YYYY-MM-DD date`)
  const instant = startOfDay(value)
  if (!Number.isFinite(instant.getTime()) || instant.toISOString().slice(0, 10) !== value) throw new ComplianceRuntimeError(`${label} must be a real YYYY-MM-DD date`)
  return value
}
const requireReason = (value: unknown) => {
  if (typeof value !== 'string' || !value.trim()) throw new ComplianceRuntimeError('A nonblank reason is required')
  return value.trim()
}
export const isPostingLeaseExpired = (updatedAt: Date, now = new Date()) => updatedAt.getTime() <= now.getTime() - 5 * 60_000
export const shouldClearClosingSnapshot = (disposedVersion: number, survivingVersions: number[]) => !survivingVersions.some(version => version > disposedVersion)
export function reconciledDocumentPeriodEnd(referencedEndsAt: Date | null, coveringEndsAt: Date | null, now = new Date()) {
  const boundary = referencedEndsAt ?? coveringEndsAt ?? new Date(Date.UTC(now.getUTCFullYear() + 1, 11, 31, 23, 59, 59, 999))
  return dateOnly(boundary)
}
export function tombstoneDocumentPayload(payload: string, disposedAt: string, storageKey: string | null) {
  const document = JSON.parse(payload) as Record<string, unknown>
  const keys = [storageKey, document.thumbnailStorageKey, ...(Array.isArray(document.disposedStorageKeys) ? document.disposedStorageKeys : [])].filter((value): value is string => typeof value === 'string' && Boolean(value))
  delete document.storageKey
  delete document.thumbnailStorageKey
  delete document.thumbnailUrl
  return { payload: JSON.stringify({ ...document, disposedAt, disposedStorageKeys: [...new Set(keys)] }), storageKeys: [...new Set(keys)] }
}
export function recoveryObjectiveWindow(manifest: { recoveryPointAt: Date; createdAt: Date }, preceding: { recoveryPointAt: Date } | null, firstBackupBaseline: Date) {
  return {
    recoveryPointAt: (preceding?.recoveryPointAt ?? firstBackupBaseline).toISOString(),
    referenceAt: manifest.createdAt.toISOString(),
  }
}
export const certifiedRestoreMinutes = (reportedMinutes: number, observedMilliseconds: number) => Math.max(reportedMinutes, observedMilliseconds / 60_000)
export function mappingChartForDate(profilePayload: string | undefined, hasVersionHistory: boolean, currentChart: string): string {
  if (!profilePayload) {
    if (hasVersionHistory) throw new ComplianceRuntimeError('No authoritative company profile covers the requested mapping date', 404)
    return currentChart
  }
  let chart: unknown
  try { chart = (JSON.parse(profilePayload) as { chart?: unknown }).chart } catch { throw new ComplianceRuntimeError('The authoritative company profile is invalid', 409) }
  if (typeof chart !== 'string' || !chart.trim()) throw new ComplianceRuntimeError('The authoritative company profile has no valid chart', 409)
  return chart
}
export const mappingResolutionInstant = (date: string) => endOfDay(date)
export function canonicalPolicyStorageRegions(regions: unknown, authoritativeRegion: string): string[] {
  if (!Array.isArray(regions) || !regions.length || regions.some(region => typeof region !== 'string' || !region.trim())) throw new ComplianceRuntimeError('At least one storage region is required')
  const canonical = [...new Set(regions.map(region => (region as string).trim()))]
  if (!canonical.includes(authoritativeRegion)) throw new ComplianceRuntimeError(`allowedStorageRegions must include configured storage region ${authoritativeRegion}`, 409)
  return canonical
}
export function isCompletedDisposalRetry(artifact: { disposedAt: Date | null; storageDeletedAt: Date | null }, onDate: string) {
  return Boolean(artifact.storageDeletedAt && artifact.disposedAt && dateOnly(artifact.disposedAt) === onDate)
}
export function requireOpenDraftPeriod(status: string) {
  if (status !== 'OPEN') throw new ComplianceRuntimeError('Drafts can only be created or revised in an open fiscal period', 409)
}
export function assertRestoreCertificationPolicy(policy: { operatorIds: string; recoveryPointObjectiveMinutes: number; recoveryTimeObjectiveMinutes: number } | null, actorId: string, recoveryWindow: { recoveryPointAt: string; referenceAt: string }, restoreMinutes: number) {
  if (!policy) throw new ComplianceRuntimeError('Compliance policy is no longer available', 403)
  let operators: unknown
  try { operators = JSON.parse(policy.operatorIds) } catch { throw new ComplianceRuntimeError('Compliance policy operator authorization is invalid', 409) }
  if (!Array.isArray(operators) || !operators.includes(actorId)) throw new ComplianceRuntimeError('The authenticated user is no longer an operator for this tenant', 403)
  assertRecoveryObjectives(recoveryWindow.recoveryPointAt, recoveryWindow.referenceAt, policy.recoveryPointObjectiveMinutes, restoreMinutes, policy.recoveryTimeObjectiveMinutes)
}
export function overviewProfilePayload(activeVersionPayload: string | undefined, versionCount: number, cachedProfile: unknown) {
  if (activeVersionPayload) return activeVersionPayload
  return versionCount === 0 && cachedProfile ? JSON.stringify(cachedProfile) : undefined
}

export async function getComplianceOverview(ownerId: string, at = new Date()) {
  if (!Number.isFinite(at.getTime())) throw new ComplianceRuntimeError('Invalid overview date')
  const [settings, versions, addressConfirmations, periods, ledgerProfile, mappings, auditSnapshot, policy, artifacts, drafts, reopenRequests, amendments, backups] = await Promise.all([
    prisma.accountRecord.findUnique({ where: { ownerId } }),
    prisma.companyProfileVersion.findMany({ where: { ownerId }, orderBy: { effectiveFrom: 'asc' } }),
    prisma.companyProfileAddressConfirmation.findMany({ where: { ownerId }, orderBy: { createdAt: 'asc' } }),
    prisma.fiscalYear.findMany({ where: { ownerId }, orderBy: { startsAt: 'asc' } }),
    prisma.ledgerProfile.findUnique({ where: { ownerId } }),
    prisma.accountMappingVersion.findMany({ where: { ownerId }, orderBy: [{ effectiveFrom: 'asc' }, { accountNumber: 'asc' }] }),
    prisma.$transaction(async transaction => ({ audit: await transaction.auditEvent.findMany({ where: { ownerId }, orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }] }), auditHead: await transaction.auditHead.findUnique({ where: { ownerId } }) })),
    prisma.compliancePolicy.findUnique({ where: { ownerId } }),
    prisma.retainedArtifact.findMany({ where: { ownerId }, orderBy: { createdAt: 'desc' }, take: 100 }),
    prisma.journalDraft.findMany({ where: { ownerId }, orderBy: { updatedAt: 'desc' }, take: 50 }),
    prisma.periodReopenRequest.findMany({ where: { ownerId }, orderBy: { requestedAt: 'desc' }, take: 50 }),
    prisma.filingAmendment.findMany({ where: { ownerId }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.backupManifest.findMany({ where: { ownerId }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, createdAt: true, storageRegion: true, recoveryPointAt: true, verifiedAt: true, restoredAt: true, status: true, databaseHash: true, objectStoreHash: true, encryptionKeyId: true, manifest: true } }),
  ])
  const activeVersion = [...versions].reverse().find(version => version.effectiveFrom <= at && (!version.effectiveTo || version.effectiveTo >= at))
  const cached = settings ? JSON.parse(settings.payload) as { companyProfile?: unknown } : undefined
  const activeAddressConfirmation = activeVersion ? addressConfirmations.find(confirmation => confirmation.profileVersionId === activeVersion.id) : undefined
  const selectedProfilePayload = activeVersion ? profilePayloadWithConfirmedAddress(activeVersion.payload, activeAddressConfirmation?.payload) : overviewProfilePayload(undefined, versions.length, cached?.companyProfile)
  const profile = selectedProfilePayload ? JSON.parse(selectedProfilePayload) as CompanyProfile : undefined
  if (profile) validateAuthoritativeProfile(profile)
  return {
    tenantId: ownerId,
    profile: profile ? { value: profile, effectiveFrom: activeVersion ? dateOnly(activeVersion.effectiveFrom) : null, applicability: deriveReportApplicability(profile) } : null,
    periods: periods.map(period => ({ id: period.id, referenceYear: period.year, label: period.label ?? String(period.year), startsAt: dateOnly(period.startsAt), endsAt: dateOnly(period.endsAt), status: period.status })),
    chart: ledgerProfile ? { ...ledgerProfile, mappings: mappings.map(toPublicMapping) } : null,
    audit: { events: auditSnapshot.audit.map(event => { let semanticDelta: unknown = null; try { semanticDelta = JSON.parse(event.semanticDelta) } catch { semanticDelta = null }; return { ...event, semanticDelta } }), verified: verifyAuditChain(auditSnapshot.audit, auditSnapshot.auditHead), head: auditSnapshot.auditHead },
    operations: {
      policy: policy ? { ...policy, allowedStorageRegions: JSON.parse(policy.allowedStorageRegions), operatorIds: JSON.parse(policy.operatorIds) } : null,
      profileAddressMigrations: versions.filter(version => !(JSON.parse(version.payload) as CompanyProfile).registeredAddress).map(version => ({ id: version.id, effectiveFrom: version.effectiveFrom, confirmed: addressConfirmations.some(confirmation => confirmation.profileVersionId === version.id) })),
      artifacts, drafts: drafts.map(draft => ({ ...draft, payload: JSON.parse(draft.payload) })), reopenRequests, amendments, backups,
    },
  }
}

export async function confirmHistoricalProfileAddress(ownerId: string, actorId: string, profileVersionId: string, address: unknown, reasonValue: unknown) {
  const reason = requireReason(reasonValue)
  return prisma.$transaction(async transaction => {
    const version = await transaction.companyProfileVersion.findFirst({ where: { id: profileVersionId, ownerId } })
    if (!version) throw new ComplianceRuntimeError('Historical company profile version not found', 404)
    const profile = JSON.parse(version.payload) as CompanyProfile
    if (profile.registeredAddress) throw new ComplianceRuntimeError('Historical company profile already contains a versioned address', 409)
    const upgraded = upgradeProfileRegisteredAddress(profile, address)
    const issues = validateVersionedCompanyProfile(upgraded)
    if (issues.length) throw new ComplianceRuntimeError(issues.join('; '))
    const payload = JSON.stringify((upgraded as CompanyProfile).registeredAddress)
    const existing = await transaction.companyProfileAddressConfirmation.findUnique({ where: { profileVersionId } })
    if (existing) {
      if (!profilesSemanticallyEqual(JSON.parse(existing.payload), JSON.parse(payload))) throw new ComplianceRuntimeError('A different historical address was already confirmed', 409)
      return existing
    }
    const confirmation = await transaction.companyProfileAddressConfirmation.create({ data: { ownerId, profileVersionId, payload, createdBy: actorId, reason } })
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'HISTORICAL_PROFILE_ADDRESS_CONFIRMED', reason, objectType: 'CompanyProfileVersion', objectId: profileVersionId, after: { confirmationId: confirmation.id, address: JSON.parse(payload) } })
    return confirmation
  })
}

export async function createFiscalPeriod(ownerId: string, actorId: string, input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ComplianceRuntimeError('Fiscal period payload must be an object')
  const value = input as Record<string, unknown>
  if (!Number.isInteger(value.referenceYear) || Number(value.referenceYear) < 1900 || Number(value.referenceYear) > 2200) throw new ComplianceRuntimeError('referenceYear must be an integer from 1900 to 2200')
  if (typeof value.startsAt !== 'string' || typeof value.endsAt !== 'string') throw new ComplianceRuntimeError('startsAt and endsAt are required')
  const reason = requireReason(value.reason)
  const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : randomUUID()
  return prisma.$transaction(async transaction => {
    const existing = await transaction.fiscalYear.findMany({ where: { ownerId }, orderBy: { startsAt: 'asc' } })
    const candidate = { id, ownerId, label: typeof value.label === 'string' && value.label.trim() ? value.label.trim() : String(value.referenceYear), startsAt: value.startsAt as string, endsAt: value.endsAt as string }
    const issues = validateFiscalPeriods([...existing.map(period => ({ id: period.id, ownerId, label: period.label ?? String(period.year), startsAt: dateOnly(period.startsAt), endsAt: dateOnly(period.endsAt) })), candidate])
    issues.push(...validateReferenceYearOrder([...existing.map(period => ({ referenceYear: period.year, startsAt: dateOnly(period.startsAt) })), { referenceYear: Number(value.referenceYear), startsAt: candidate.startsAt }]))
    if (issues.length) throw new ComplianceRuntimeError(issues.join('; '))
    const created = await transaction.fiscalYear.create({ data: { id, ownerId, year: Number(value.referenceYear), label: candidate.label, startsAt: startOfDay(candidate.startsAt), endsAt: endOfDay(candidate.endsAt) } })
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'FISCAL_PERIOD_CREATED', reason, objectType: 'FiscalYear', objectId: created.id, after: candidate })
    return created
  })
}

export async function resolveMappings(ownerId: string, date: string, accountNumbers?: number[]) {
  date = requireIsoDate(date, 'date')
  const instant = mappingResolutionInstant(date)
  const [profile, effectiveProfile, profileVersionCount] = await Promise.all([
    prisma.ledgerProfile.findUnique({ where: { ownerId } }),
    prisma.companyProfileVersion.findFirst({ where: { ownerId, effectiveFrom: { lte: instant }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: instant } }] }, orderBy: { effectiveFrom: 'desc' }, select: { payload: true } }),
    prisma.companyProfileVersion.count({ where: { ownerId } }),
  ])
  if (!profile) throw new ComplianceRuntimeError('No authoritative ledger profile exists', 404)
  const chartId = mappingChartForDate(effectiveProfile?.payload, profileVersionCount > 0, profile.chart)
  const latest = await prisma.accountMappingVersion.findFirst({ where: { ownerId, chartId, effectiveFrom: { lte: instant }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: instant } }] }, orderBy: { effectiveFrom: 'desc' }, select: { effectiveFrom: true } })
  if (!latest) throw new ComplianceRuntimeError('No mapping version covers the requested date', 404)
  const rows = await prisma.accountMappingVersion.findMany({ where: { ownerId, chartId, effectiveFrom: latest.effectiveFrom, OR: [{ effectiveTo: null }, { effectiveTo: { gte: instant } }] }, orderBy: { accountNumber: 'asc' } })
  const mappings = rows.map(toMapping)
  const issues = validateMappings(mappings, accountNumbers)
  if (issues.length) throw new ComplianceRuntimeError(issues.join('; '))
  return { chartId, effectiveFrom: dateOnly(latest.effectiveFrom), mappings }
}

export async function mappingAuditExport(ownerId: string) {
  const rows = await prisma.accountMappingVersion.findMany({ where: { ownerId }, orderBy: [{ chartId: 'asc' }, { effectiveFrom: 'asc' }, { accountNumber: 'asc' }] })
  return rows.map(toPublicMapping)
}

export async function createDraft(ownerId: string, actorId: string, input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ComplianceRuntimeError('Draft payload must be an object')
  const value = input as { fiscalPeriodId?: unknown; posting?: unknown; reason?: unknown }
  if (typeof value.fiscalPeriodId !== 'string') throw new ComplianceRuntimeError('fiscalPeriodId is required')
  validateJournalEntry(value.posting)
  const reason = requireReason(value.reason)
  return prisma.$transaction(async transaction => {
    const period = await transaction.fiscalYear.findFirst({ where: { id: value.fiscalPeriodId as string, ownerId } })
    if (!period) throw new ComplianceRuntimeError('Fiscal period not found', 404)
    requireOpenDraftPeriod(period.status)
    const bookingDate = (value.posting as { bookingDate: string }).bookingDate
    if (bookingDate < dateOnly(period.startsAt) || bookingDate > dateOnly(period.endsAt)) throw new ComplianceRuntimeError('Draft booking date is outside its fiscal period')
    const draft = await transaction.journalDraft.create({ data: { ownerId, fiscalYearId: period.id, payload: JSON.stringify(value.posting), createdBy: actorId, updatedBy: actorId } })
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'JOURNAL_DRAFT_CREATED', reason, objectType: 'JournalDraft', objectId: draft.id, after: value.posting })
    return draft
  })
}

export async function reviseDraft(ownerId: string, actorId: string, draftId: string, input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ComplianceRuntimeError('Draft revision must be an object')
  const value = input as { posting?: unknown; expectedVersion?: unknown; reason?: unknown }
  validateJournalEntry(value.posting)
  if (!Number.isInteger(value.expectedVersion)) throw new ComplianceRuntimeError('expectedVersion is required')
  const reason = requireReason(value.reason)
  return prisma.$transaction(async transaction => {
    const before = await transaction.journalDraft.findFirst({ where: { id: draftId, ownerId, status: 'DRAFT' } })
    if (!before) throw new ComplianceRuntimeError('Editable draft not found', 404)
    const period = await transaction.fiscalYear.findFirst({ where: { id: before.fiscalYearId, ownerId } })
    if (!period) throw new ComplianceRuntimeError('Fiscal period not found', 404)
    requireOpenDraftPeriod(period.status)
    const bookingDate = (value.posting as { bookingDate: string }).bookingDate
    if (bookingDate < dateOnly(period.startsAt) || bookingDate > dateOnly(period.endsAt)) throw new ComplianceRuntimeError('Draft booking date is outside its fiscal period')
    const updated = await transaction.journalDraft.updateMany({ where: { id: draftId, ownerId, status: 'DRAFT', version: Number(value.expectedVersion) }, data: { payload: JSON.stringify(value.posting), version: { increment: 1 }, updatedBy: actorId } })
    if (updated.count !== 1) throw new ComplianceRuntimeError('Draft changed concurrently', 409)
    const after = await transaction.journalDraft.findUniqueOrThrow({ where: { id: draftId } })
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'JOURNAL_DRAFT_REVISED', reason, objectType: 'JournalDraft', objectId: draftId, before: JSON.parse(before.payload), after: value.posting })
    return after
  })
}

export async function postDraft(ownerId: string, actorId: string, draftId: string, reasonValue: unknown) {
  const reason = requireReason(reasonValue)
  const existingDraft = await prisma.journalDraft.findFirst({ where: { id: draftId, ownerId } })
  if (!existingDraft) throw new ComplianceRuntimeError('Draft not found', 404)
  if (existingDraft.status === 'POSTED' && existingDraft.postedEntryId) return prisma.journalEntry.findFirstOrThrow({ where: { id: existingDraft.postedEntryId, fiscalYear: { ownerId } }, include: { lines: true, documents: true } })
  const finalize = async (entry: { id: string }) => prisma.$transaction(async transaction => {
    const updated = await transaction.journalDraft.updateMany({ where: { id: draftId, ownerId, status: 'POSTING' }, data: { status: 'POSTED', postedEntryId: entry.id, updatedBy: actorId } })
    if (updated.count !== 1) {
      const current = await transaction.journalDraft.findFirst({ where: { id: draftId, ownerId } })
      if (current?.status === 'POSTED' && current.postedEntryId === entry.id) return entry
      throw new ComplianceRuntimeError('Draft posting state changed during finalization', 409)
    }
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'JOURNAL_DRAFT_POSTED', reason, objectType: 'JournalEntry', objectId: entry.id, after: { draftId, entryId: entry.id } })
    return entry
  })
  if (existingDraft.status === 'POSTING') {
    const recovered = await prisma.journalEntry.findUnique({ where: { externalKey: `DRAFT:${draftId}` }, include: { lines: true, documents: true } })
    if (recovered) return finalize(recovered)
    const now = new Date()
    const leaseCutoff = new Date(now.getTime() - 5 * 60_000)
    if (isPostingLeaseExpired(existingDraft.updatedAt, now)) {
      const released = await prisma.journalDraft.updateMany({ where: { id: draftId, ownerId, status: 'POSTING', updatedAt: { lte: leaseCutoff } }, data: { status: 'DRAFT', updatedBy: actorId } })
      if (released.count === 1) return postDraft(ownerId, actorId, draftId, reason)
    }
    throw new ComplianceRuntimeError('Draft posting is already in progress', 409)
  }
  const claimed = await prisma.journalDraft.updateMany({ where: { id: draftId, ownerId, status: 'DRAFT' }, data: { status: 'POSTING', updatedBy: actorId } })
  if (claimed.count !== 1) throw new ComplianceRuntimeError('Draft is not available for posting', 409)
  const draft = await prisma.journalDraft.findUniqueOrThrow({ where: { id: draftId } })
  let entry
  try { entry = await postJournalEntry(ownerId, JSON.parse(draft.payload), 'MANUAL', { externalKey: `DRAFT:${draftId}` }) }
  catch (error) {
    const recovered = await prisma.journalEntry.findUnique({ where: { externalKey: `DRAFT:${draftId}` }, include: { lines: true, documents: true } })
    if (recovered) return finalize(recovered)
    await prisma.journalDraft.updateMany({ where: { id: draftId, ownerId, status: 'POSTING' }, data: { status: 'DRAFT', updatedBy: actorId } })
    throw error
  }
  return finalize(entry)
}

export async function correctPostedEntry(ownerId: string, actorId: string, originalId: string, input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ComplianceRuntimeError('Correction payload must be an object')
  const value = input as { replacement?: unknown; reason?: unknown; entryDate?: unknown }
  const reason = requireReason(value.reason)
  validateJournalEntry(value.replacement)
  const original = await prisma.journalEntry.findFirst({ where: { id: originalId, fiscalYear: { ownerId }, state: 'POSTED' }, include: { lines: true, fiscalYear: true } })
  if (!original) throw new ComplianceRuntimeError('Posted entry not found', 404)
  const existingCorrection = await prisma.journalEntry.findMany({
    where: { externalKey: { in: [`CORRECTION:${originalId}:REVERSAL`, `CORRECTION:${originalId}:REPLACEMENT`] } },
    select: { entryDate: true },
  })
  const persistedDates = [...new Set(existingCorrection.map(entry => entry.entryDate ? dateOnly(entry.entryDate) : null))]
  if (persistedDates.length > 1 || persistedDates[0] === null) throw new ComplianceRuntimeError('Persisted correction entry dates are inconsistent', 409)
  const entryDate = resolveCorrectionEntryDate(value.entryDate, original.entryDate, new Date(), persistedDates[0])
  const stornoInput = { fiscalYear: original.fiscalYear.year, bookingDate: dateOnly(original.bookingDate), documentNumber: `STORNO-${original.documentNumber}-${original.id.slice(-8)}`, description: `Storno: ${reason}`, lines: original.lines.map(line => ({ accountId: line.accountId, debitCents: line.creditCents, creditCents: line.debitCents, ...(line.taxCode ? { taxCode: line.taxCode } : {}) })) }
  return postJournalCorrection(ownerId, actorId, original.id, stornoInput, value.replacement, entryDate, reason)
}

export async function requestPeriodReopen(ownerId: string, actorId: string, periodId: string, reasonValue: unknown) {
  const reason = requireReason(reasonValue)
  return prisma.$transaction(async transaction => {
    const period = await transaction.fiscalYear.findFirst({ where: { id: periodId, ownerId, status: 'CLOSED' } })
    if (!period) throw new ComplianceRuntimeError('Closed fiscal period not found', 404)
    if (!period.lockedAt) throw new ComplianceRuntimeError('Closed fiscal period has no close-generation marker', 409)
    const request = await transaction.periodReopenRequest.create({ data: { ownerId, fiscalYearId: periodId, requestedBy: actorId, closeGenerationAt: period.lockedAt, reason, status: 'PENDING' } })
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'PERIOD_REOPEN_REQUESTED', reason, objectType: 'FiscalYear', objectId: periodId, after: { requestId: request.id } })
    return request
  })
}

export async function decidePeriodReopen(ownerId: string, actorId: string, requestId: string, approve: boolean, reasonValue: unknown) {
  const reason = requireReason(reasonValue)
  return prisma.$transaction(async transaction => {
    const request = await transaction.periodReopenRequest.findFirst({ where: { id: requestId, ownerId, status: 'PENDING' } })
    if (!request) throw new ComplianceRuntimeError('Pending reopen request not found', 404)
    if (request.requestedBy === actorId) throw new ComplianceRuntimeError('Four-eyes approval is required', 403)
    const status = approve ? 'APPROVED' : 'REJECTED'
    if (approve) {
      if (!request.closeGenerationAt) throw new ComplianceRuntimeError('Reopen request predates close-generation controls and must be recreated', 409)
      const period = await transaction.fiscalYear.findFirst({ where: { id: request.fiscalYearId, ownerId } })
      if (!period || !matchesCloseGeneration(period, request.closeGenerationAt)) throw new ComplianceRuntimeError('Reopen request is stale for the current close generation', 409)
      const closedSuccessor = await transaction.fiscalYear.findFirst({ where: { ownerId, year: { gt: period.year }, status: 'CLOSED' }, orderBy: { year: 'asc' } })
      const topologyIssues = validateReopenTopology(period.year, closedSuccessor ? [closedSuccessor.year] : [])
      if (topologyIssues.length) throw new ComplianceRuntimeError(topologyIssues[0], 409)
    }
    const decided = await transaction.periodReopenRequest.update({ where: { id: requestId }, data: { status, approvedBy: actorId, decidedAt: new Date() } })
    if (approve) {
      await transaction.fiscalYear.update({ where: { id: request.fiscalYearId }, data: { status: 'REOPENED' } })
      await transaction.periodReopenRequest.updateMany({ where: { ownerId, fiscalYearId: request.fiscalYearId, status: 'PENDING', id: { not: requestId } }, data: { status: 'SUPERSEDED', approvedBy: actorId, decidedAt: new Date() } })
    }
    await appendAuditEvent(transaction, { ownerId, actorId, action: approve ? 'PERIOD_REOPEN_APPROVED' : 'PERIOD_REOPEN_REJECTED', reason, objectType: 'FiscalYear', objectId: request.fiscalYearId, before: { status: 'CLOSED' }, after: { status: approve ? 'REOPENED' : 'CLOSED', requestId } })
    return decided
  })
}

export async function createFilingAmendment(ownerId: string, actorId: string, input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ComplianceRuntimeError('Amendment payload must be an object')
  const value = input as Record<string, unknown>
  if (!['VAT', 'E_BILANZ'].includes(String(value.kind))) throw new ComplianceRuntimeError('kind must be VAT or E_BILANZ')
  if (value.kind === 'VAT') throw new ComplianceRuntimeError('VAT amendments are unavailable until the original VAT request, response and receipt retention contract is configured', 409)
  if (typeof value.originalObjectId !== 'string' || typeof value.requestPayload !== 'string') throw new ComplianceRuntimeError('Original and request payload are required')
  const reason = requireReason(value.reason)
  return prisma.$transaction(async transaction => {
    if (value.kind === 'E_BILANZ') {
      const original = await transaction.eBalanceSubmission.findFirst({ where: { id: value.originalObjectId as string, ownerId, status: 'ACCEPTED' } })
      if (!original || !original.serverResponseXml || !original.resultXml) throw new ComplianceRuntimeError('Accepted original request, response and receipt must be retained before amendment')
    }
    const amendment = await transaction.filingAmendment.create({ data: { ownerId, kind: String(value.kind), originalObjectId: value.originalObjectId as string, requestPayload: value.requestPayload as string, reason, createdBy: actorId } })
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'FILING_AMENDMENT_CREATED', reason, objectType: 'FilingAmendment', objectId: amendment.id, after: { kind: value.kind, originalObjectId: value.originalObjectId } })
    return amendment
  })
}

export async function configureCompliancePolicy(ownerId: string, actorId: string, input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ComplianceRuntimeError('Policy payload must be an object')
  const value = input as Record<string, unknown>
  let authoritativeRegion: string
  try { authoritativeRegion = getAuthoritativeStorageRegion() } catch (error) { throw new ComplianceRuntimeError(error instanceof Error ? error.message : 'Storage region is unavailable', 503) }
  const allowedStorageRegions = canonicalPolicyStorageRegions(value.allowedStorageRegions, authoritativeRegion)
  if (!Array.isArray(value.operatorIds) || !value.operatorIds.includes(actorId) || value.operatorIds.some(id => typeof id !== 'string' || !id.trim())) throw new ComplianceRuntimeError('operatorIds must include the configuring actor')
  for (const field of ['recoveryPointObjectiveMinutes', 'recoveryTimeObjectiveMinutes'] as const) if (!Number.isInteger(value[field]) || Number(value[field]) < 0) throw new ComplianceRuntimeError(`${field} must be a nonnegative integer`)
  if (typeof value.backupKeyId !== 'string' || !value.backupKeyId.trim()) throw new ComplianceRuntimeError('backupKeyId is required')
  const backupKeyId = value.backupKeyId
  const reason = requireReason(value.reason)
  return prisma.$transaction(async transaction => {
    const before = await transaction.compliancePolicy.findUnique({ where: { ownerId } })
    const data = { allowedStorageRegions: JSON.stringify(allowedStorageRegions), operatorIds: JSON.stringify(value.operatorIds), recoveryPointObjectiveMinutes: Number(value.recoveryPointObjectiveMinutes), recoveryTimeObjectiveMinutes: Number(value.recoveryTimeObjectiveMinutes), backupKeyId: backupKeyId.trim() }
    const policy = await transaction.compliancePolicy.upsert({ where: { ownerId }, create: { ownerId, ...data }, update: data })
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'COMPLIANCE_POLICY_CHANGED', reason, objectType: 'CompliancePolicy', objectId: ownerId, before, after: data })
    return policy
  })
}

async function requireOperator(ownerId: string, actorId: string) {
  const policy = await prisma.compliancePolicy.findUnique({ where: { ownerId } })
  if (!policy || !(JSON.parse(policy.operatorIds) as unknown[]).includes(actorId)) throw new ComplianceRuntimeError('Compliance operator authorization is required', 403)
  return policy
}

export async function registerRetainedArtifact(ownerId: string, actorId: string, input: { objectType: string; objectId: string; retentionClass: RetentionClass; periodEndsAt: string; provenance: string; storageKey?: string; content: Uint8Array; reason: string }) {
  const reason = requireReason(input.reason)
  const deadline = retentionDeadline(input.retentionClass, input.periodEndsAt)
  return prisma.$transaction(async transaction => {
    const latest = await transaction.retainedArtifact.findFirst({ where: { ownerId, objectType: input.objectType, objectId: input.objectId }, orderBy: { version: 'desc' } })
    const artifact = await transaction.retainedArtifact.create({ data: { ownerId, objectType: input.objectType, objectId: input.objectId, version: (latest?.version ?? 0) + 1, retentionClass: input.retentionClass, contentHash: sha256(input.content), provenance: input.provenance, storageKey: input.storageKey, periodEndsAt: endOfDay(input.periodEndsAt), retainUntil: endOfDay(deadline.retainUntil) } })
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'ARTIFACT_REGISTERED', reason, objectType: input.objectType, objectId: input.objectId, after: { artifactId: artifact.id, version: artifact.version, contentHash: artifact.contentHash, retainUntil: deadline.retainUntil } })
    return artifact
  })
}

export async function reconcileDocumentArtifacts(ownerId: string, actorId: string, reasonValue: unknown) {
  await requireOperator(ownerId, actorId)
  const reason = requireReason(reasonValue)
  const [documents, registered] = await Promise.all([
    prisma.documentRecord.findMany({ where: { ownerId }, select: { id: true, payload: true } }),
    prisma.retainedArtifact.findMany({ where: { ownerId, objectType: 'Document' }, select: { objectId: true } }),
  ])
  const [attachments, coveringPeriod] = await Promise.all([
    prisma.journalDocumentAttachment.findMany({
      where: { documentId: { in: documents.map(document => document.id) }, journalEntry: { fiscalYear: { ownerId } } },
      select: { documentId: true, journalEntry: { select: { fiscalYear: { select: { endsAt: true } } } } },
    }),
    prisma.fiscalYear.findFirst({ where: { ownerId, startsAt: { lte: new Date() }, endsAt: { gte: new Date() } }, orderBy: { endsAt: 'desc' }, select: { endsAt: true } }),
  ])
  const referencedEnds = new Map<string, Date>()
  for (const attachment of attachments) {
    const endsAt = attachment.journalEntry.fiscalYear.endsAt
    const prior = referencedEnds.get(attachment.documentId)
    if (!prior || endsAt > prior) referencedEnds.set(attachment.documentId, endsAt)
  }
  const known = new Set(registered.map(item => item.objectId)); let added = 0
  for (const document of documents) {
    if (known.has(document.id)) continue
    let payload: { storageKey?: unknown }
    try { payload = JSON.parse(document.payload) } catch { continue }
    if (typeof payload.storageKey !== 'string' || !payload.storageKey) continue
    const content = await getDocumentStorage().read(payload.storageKey)
    const periodEndsAt = reconciledDocumentPeriodEnd(referencedEnds.get(document.id) ?? null, coveringPeriod?.endsAt ?? null)
    await registerRetainedArtifact(ownerId, actorId, { objectType: 'Document', objectId: document.id, retentionClass: 'INVOICE', periodEndsAt, provenance: 'legacy document retention reconciliation against authoritative fiscal-period topology', storageKey: payload.storageKey, content, reason })
    added++
  }
  return { inspected: documents.length, added }
}

export async function placeLegalHold(ownerId: string, actorId: string, artifactId: string, until: string, holdReason: unknown) {
  const reason = requireReason(holdReason)
  until = requireIsoDate(until, 'until')
  return prisma.$transaction(async transaction => {
    await transaction.$executeRaw`UPDATE RetainedArtifact SET id = id WHERE id = ${artifactId} AND ownerId = ${ownerId}`
    const artifact = await transaction.retainedArtifact.findFirst({ where: { id: artifactId, ownerId, disposedAt: null } })
    if (!artifact) throw new ComplianceRuntimeError('Retained artifact not found', 404)
    const currentBoundary = artifact.legalHoldUntil && artifact.legalHoldUntil > artifact.retainUntil ? artifact.legalHoldUntil : artifact.retainUntil
    if (endOfDay(until) <= currentBoundary) throw new ComplianceRuntimeError('Legal hold must extend the current retention period and cannot shorten an existing hold')
    const changed = await transaction.retainedArtifact.updateMany({ where: { id: artifactId, ownerId, disposedAt: null }, data: { legalHoldUntil: endOfDay(until), legalHoldReason: reason } })
    if (changed.count !== 1) throw new ComplianceRuntimeError('Artifact disposal started concurrently', 409)
    const updated = await transaction.retainedArtifact.findUniqueOrThrow({ where: { id: artifactId } })
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'LEGAL_HOLD_PLACED', reason, objectType: artifact.objectType, objectId: artifact.objectId, before: { legalHoldUntil: artifact.legalHoldUntil }, after: { legalHoldUntil: until } })
    return updated
  })
}

export async function runFixityCheck(ownerId: string, actorId: string, artifactId: string, reasonValue: unknown) {
  await requireOperator(ownerId, actorId)
  const reason = requireReason(reasonValue)
  const artifact = await prisma.retainedArtifact.findFirst({ where: { id: artifactId, ownerId, disposedAt: null } })
  if (!artifact?.storageKey) throw new ComplianceRuntimeError('Artifact has no readable storage object', 404)
  let content: Buffer | undefined
  try { content = await getDocumentStorage().read(artifact.storageKey) } catch { content = undefined }
  const actualHash = content ? sha256(content) : null
  const status = content && actualHash === artifact.contentHash ? 'VALID' : content ? 'TAMPERED' : 'UNREADABLE'
  return prisma.$transaction(async transaction => {
    const check = await transaction.fixityCheck.create({ data: { ownerId, artifactId, expectedHash: artifact.contentHash, actualHash, status, readable: Boolean(content) } })
    await transaction.retainedArtifact.update({ where: { id: artifactId }, data: { lastFixityAt: check.checkedAt } })
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'FIXITY_CHECKED', reason, objectType: artifact.objectType, objectId: artifact.objectId, after: { status, expectedHash: artifact.contentHash, actualHash } })
    return check
  })
}

export async function runDueFixityChecks(ownerId: string, actorId: string, before: string, reasonValue: unknown) {
  await requireOperator(ownerId, actorId)
  const reason = requireReason(reasonValue)
  before = requireIsoDate(before, 'before')
  const due = await prisma.retainedArtifact.findMany({ where: { ownerId, disposedAt: null, storageKey: { not: null }, OR: [{ lastFixityAt: null }, { lastFixityAt: { lt: startOfDay(before) } }] }, select: { id: true }, orderBy: { createdAt: 'asc' }, take: 100 })
  const checks = []
  for (const artifact of due) checks.push(await runFixityCheck(ownerId, actorId, artifact.id, reason))
  return { checked: checks.length, valid: checks.filter(check => check.status === 'VALID').length, failed: checks.filter(check => check.status !== 'VALID').length, checks }
}

export async function disposeArtifact(ownerId: string, actorId: string, artifactId: string, onDate: string, reasonValue: unknown) {
  await requireOperator(ownerId, actorId)
  const reason = requireReason(reasonValue)
  onDate = requireIsoDate(onDate, 'onDate')
  if (onDate > dateOnly(new Date())) throw new ComplianceRuntimeError('Future disposal dates must be scheduled and cannot delete content immediately')
  const disposal = await prisma.$transaction(async transaction => {
    await transaction.$executeRaw`UPDATE RetainedArtifact SET id = id WHERE id = ${artifactId} AND ownerId = ${ownerId}`
    const current = await transaction.retainedArtifact.findFirst({ where: { id: artifactId, ownerId } })
    if (!current) throw new ComplianceRuntimeError('Retained artifact not found', 404)
    if (current.storageDeletedAt) {
      if (isCompletedDisposalRetry(current, onDate)) return { artifact: current, storageKeys: [], completed: true }
      throw new ComplianceRuntimeError(`Artifact disposal was already completed on ${current.disposedAt ? dateOnly(current.disposedAt) : 'an unknown date'}`, 409)
    }
    const boundary = current.legalHoldUntil && current.legalHoldUntil > current.retainUntil ? current.legalHoldUntil : current.retainUntil
    if (!current.disposedAt && endOfDay(onDate) <= boundary) throw new ComplianceRuntimeError('Artifact is still retained or under legal hold')
    if (current.disposedAt && dateOnly(current.disposedAt) !== onDate) throw new ComplianceRuntimeError(`Artifact disposal was already recorded on ${dateOnly(current.disposedAt)}`)
    const survivingReference = current.storageKey ? await transaction.retainedArtifact.findFirst({ where: { ownerId, id: { not: artifactId }, storageKey: current.storageKey, disposedAt: null, storageDeletedAt: null } }) : null
    let storageKeys = current.storageKey && !survivingReference ? [current.storageKey] : []
    if (!current.disposedAt) {
      await transaction.retainedArtifact.update({ where: { id: artifactId }, data: { disposalRequestedAt: new Date(), disposedAt: endOfDay(onDate) } })
      if (current.objectType === 'Document' && !survivingReference) {
        const document = await transaction.documentRecord.findFirst({ where: { id: current.objectId, ownerId } })
        if (document) {
          const tombstone = tombstoneDocumentPayload(document.payload, onDate, current.storageKey)
          storageKeys = tombstone.storageKeys
          const updated = await transaction.documentRecord.updateMany({ where: { id: document.id, ownerId, payload: document.payload }, data: { payload: tombstone.payload } })
          if (updated.count !== 1) throw new ComplianceRuntimeError('Document changed concurrently during disposal', 409)
        }
      }
      await appendAuditEvent(transaction, { ownerId, actorId, action: 'ARTIFACT_DISPOSAL_APPROVED', reason, objectType: current.objectType, objectId: current.objectId, before: { contentHash: current.contentHash, legalHoldUntil: current.legalHoldUntil }, after: { disposedAt: onDate } })
    } else if (current.objectType === 'Document' && !survivingReference) {
      const document = await transaction.documentRecord.findFirst({ where: { id: current.objectId, ownerId } })
      if (document) storageKeys = tombstoneDocumentPayload(document.payload, onDate, current.storageKey).storageKeys
    }
    return { artifact: current, storageKeys, completed: false }
  })
  if (disposal.completed) return disposal.artifact
  for (const storageKey of disposal.storageKeys) await getDocumentStorage().delete(storageKey)
  const artifact = disposal.artifact
  return prisma.$transaction(async transaction => {
    if (artifact.objectType === 'ClosingSnapshot') {
      const survivingSuccessor = await transaction.retainedArtifact.findFirst({ where: { ownerId, objectType: artifact.objectType, objectId: artifact.objectId, version: { gt: artifact.version }, storageDeletedAt: null } })
      if (shouldClearClosingSnapshot(artifact.version, survivingSuccessor ? [survivingSuccessor.version] : [])) await transaction.fiscalYear.updateMany({ where: { id: artifact.objectId, ownerId }, data: { closingSnapshot: null } })
    }
    const disposed = await transaction.retainedArtifact.update({ where: { id: artifactId }, data: { storageDeletedAt: new Date() } })
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'ARTIFACT_STORAGE_DELETED', reason, objectType: artifact.objectType, objectId: artifact.objectId, after: { disposedAt: onDate } })
    return disposed
  })
}

function backupKey(keyId: string): Buffer {
  try { return resolveBackupKey(keyId) }
  catch (error) { throw new ComplianceRuntimeError(error instanceof Error ? error.message : 'Backup encryption key is unavailable', 503) }
}

export async function createTenantBackup(ownerId: string, actorId: string, region: string, reasonValue: unknown) {
  await requireOperator(ownerId, actorId)
  const reason = requireReason(reasonValue)
  await reconcileDocumentArtifacts(ownerId, actorId, 'Pre-backup retained-artifact reconciliation')
  const snapshot = await prisma.$transaction(async transaction => {
    const recoveryPointAt = new Date().toISOString()
    const settings = await transaction.accountRecord.findMany({ where: { ownerId } })
    const profiles = await transaction.companyProfileVersion.findMany({ where: { ownerId } })
    const profileAddressConfirmations = await transaction.companyProfileAddressConfirmation.findMany({ where: { ownerId } })
    const periods = await transaction.fiscalYear.findMany({ where: { ownerId } })
    const ledgerProfile = await transaction.ledgerProfile.findUnique({ where: { ownerId } })
    const accounts = await transaction.ledgerAccount.findMany({ where: { ownerId } })
    const mappings = await transaction.accountMappingVersion.findMany({ where: { ownerId } })
    const entries = await transaction.journalEntry.findMany({ where: { fiscalYear: { ownerId } }, include: { lines: true, documents: true } })
    const documents = await transaction.documentRecord.findMany({ where: { ownerId } })
    const storageClaims = await transaction.documentStorageClaim.findMany({ where: { ownerId } })
    const artifacts = await transaction.retainedArtifact.findMany({ where: { ownerId } })
    const fixityChecks = await transaction.fixityCheck.findMany({ where: { ownerId, artifactId: { in: artifacts.map(artifact => artifact.id) } } })
    const audit = await transaction.auditEvent.findMany({ where: { ownerId }, orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }] })
    const auditHead = await transaction.auditHead.findUnique({ where: { ownerId } })
    const drafts = await transaction.journalDraft.findMany({ where: { ownerId } })
    const reopenRequests = await transaction.periodReopenRequest.findMany({ where: { ownerId } })
    const amendments = await transaction.filingAmendment.findMany({ where: { ownerId } })
    const eBalanceSubmissions = await transaction.eBalanceSubmission.findMany({ where: { ownerId } })
    const backupManifests = excludeBackupPayloadLocators(await transaction.backupManifest.findMany({ where: { ownerId } }))
    const policySnapshot = await transaction.compliancePolicy.findUnique({ where: { ownerId } })
    return { schemaVersion: 1, recoveryPointAt, ownerId, settings, profiles, profileAddressConfirmations, periods, ledgerProfile, accounts, mappings, entries, documents, storageClaims, artifacts, fixityChecks, audit, auditHead, drafts, reopenRequests, amendments, eBalanceSubmissions, backupManifests, policy: policySnapshot }
  })
  if (!snapshot.policy || !(JSON.parse(snapshot.policy.operatorIds) as unknown[]).includes(actorId)) throw new ComplianceRuntimeError('Compliance operator authorization changed during backup capture', 403)
  const allowedRegions = JSON.parse(snapshot.policy.allowedStorageRegions) as string[]
  let authoritativeRegion: string
  try { authoritativeRegion = getAuthoritativeStorageRegion() }
  catch (error) { throw new ComplianceRuntimeError(error instanceof Error ? error.message : 'Storage region is unavailable', 503) }
  if (region !== authoritativeRegion) throw new ComplianceRuntimeError(`Requested backup region does not match configured storage region ${authoritativeRegion}`, 409)
  if (!verifyAuditChain(snapshot.audit, snapshot.auditHead)) throw new ComplianceRuntimeError('Audit chain verification failed; backup aborted', 409)
  const objects: Record<string, Buffer> = {}
  const requiredStorageKeys = snapshotStorageReferences(snapshot)
  for (const storageKey of requiredStorageKeys) objects[storageKey] = await getDocumentStorage().read(storageKey)
  try { verifyRestoredStorageObjects(snapshot.artifacts, objects, requiredStorageKeys) }
  catch (error) { throw new ComplianceRuntimeError(`Backup object fixity verification failed: ${error instanceof Error ? error.message : 'unknown failure'}`, 409) }
  const recoveryPointAt = snapshot.recoveryPointAt
  const backupId = randomUUID()
  const database = Buffer.from(JSON.stringify(snapshot))
  const backup = createBackup({ backupId, ownerId, database, objects, recoveryPointAt, region: authoritativeRegion, keyId: snapshot.policy.backupKeyId }, backupKey(snapshot.policy.backupKeyId), allowedRegions)
  const payloadStorageKey = await persistComplianceObject({ ownerId, category: 'backups', objectId: backupId, extension: 'json', content: Buffer.from(JSON.stringify(backup)), contentType: 'application/json', fileName: `${backupId}.json` })
  try {
    return await prisma.$transaction(async transaction => {
      const stored = await transaction.backupManifest.create({ data: { id: backupId, ownerId, databaseHash: backup.databaseHash, objectStoreHash: backup.objectsHash, encryptionKeyId: backup.keyId, storageRegion: backup.region, recoveryPointAt: new Date(backup.recoveryPointAt), manifest: JSON.stringify({ schemaVersion: snapshot.schemaVersion, backupId, ownerId, objectCount: Object.keys(objects).length, auditHead: snapshot.auditHead?.headHash ?? null }), payloadStorageKey } })
      await appendAuditEvent(transaction, { ownerId, actorId, action: 'BACKUP_CREATED', reason, objectType: 'BackupManifest', objectId: stored.id, after: { region, recoveryPointAt, databaseHash: backup.databaseHash, objectsHash: backup.objectsHash, payloadStorageKey } })
      return stored
    })
  } catch (error) {
    try { await getDocumentStorage().delete(payloadStorageKey) }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Backup registration failed and its staged encrypted payload could not be cleaned up') }
    throw error
  }
}

export async function verifyTenantRestore(ownerId: string, actorId: string, backupId: string, measuredRestoreMinutes: number, reasonValue: unknown) {
  await requireOperator(ownerId, actorId)
  const reason = requireReason(reasonValue)
  if (!Number.isFinite(measuredRestoreMinutes) || measuredRestoreMinutes < 0) throw new ComplianceRuntimeError('measuredRestoreMinutes must be a nonnegative number')
  const restoreStartedAt = performance.now()
  const stored = await prisma.backupManifest.findFirst({ where: { id: backupId, ownerId } })
  if (!stored) throw new ComplianceRuntimeError('Backup manifest not found', 404)
  if (!stored.payloadStorageKey) throw new ComplianceRuntimeError('Backup payload is not available in independent storage', 409)
  let encryptedPayload: Buffer
  try { encryptedPayload = await getDocumentStorage().read(stored.payloadStorageKey) } catch { throw new ComplianceRuntimeError('Backup payload cannot be read from independent storage', 409) }
  const encrypted = JSON.parse(encryptedPayload.toString()) as EncryptedBackup
  if (!backupMatchesManifest(encrypted, stored)) throw new ComplianceRuntimeError('Backup payload does not match its selected manifest', 409)
  const manifest = JSON.parse(stored.manifest) as { schemaVersion?: unknown; backupId?: unknown; ownerId?: unknown; objectCount?: unknown }
  if (manifest.schemaVersion !== 1 || manifest.backupId !== stored.id || manifest.ownerId !== stored.ownerId) throw new ComplianceRuntimeError('Backup manifest identity is invalid', 409)
  const restored = restoreBackup(encrypted, backupKey(stored.encryptionKeyId))
  if (manifest.objectCount !== Object.keys(restored.objects).length) throw new ComplianceRuntimeError('Backup object count does not match its manifest', 409)
  const snapshot = JSON.parse(restored.database.toString()) as TenantBackupSnapshot
  if (snapshot.ownerId !== ownerId) throw new ComplianceRuntimeError('Restored snapshot belongs to a different tenant', 409)
  let isolatedDatabase: ReturnType<typeof verifySnapshotInIsolatedDatabase>
  let isolatedObjects: Awaited<ReturnType<typeof exerciseIsolatedObjectRestore>>
  try {
    verifyRestoredStorageObjects(snapshot.artifacts, restored.objects, snapshotStorageReferences(snapshot))
    isolatedDatabase = verifySnapshotInIsolatedDatabase(snapshot)
    isolatedObjects = await exerciseIsolatedObjectRestore(ownerId, backupId, restored.objects)
  } catch (error) { throw new ComplianceRuntimeError(`Isolated restore verification failed: ${error instanceof Error ? error.message : 'unknown failure'}`, 409) }
  const preceding = await prisma.backupManifest.findFirst({
    where: { ownerId, createdAt: { lt: stored.createdAt }, payloadStorageKey: { not: null }, status: { in: ['CREATED', 'RESTORE_VERIFIED'] } },
    orderBy: { createdAt: 'desc' }, select: { recoveryPointAt: true },
  })
  const policyBaseline = new Date(snapshot.policy?.updatedAt)
  if (!Number.isFinite(policyBaseline.getTime())) throw new ComplianceRuntimeError('Backup does not contain a valid recovery-policy baseline', 409)
  const recoveryWindow = recoveryObjectiveWindow(stored, preceding, policyBaseline)
  const observedRestoreMilliseconds = performance.now() - restoreStartedAt
  const observedRestoreMinutes = observedRestoreMilliseconds / 60_000
  const restoreMinutes = certifiedRestoreMinutes(measuredRestoreMinutes, observedRestoreMilliseconds)
  return prisma.$transaction(async transaction => {
    await transaction.$executeRaw`UPDATE CompliancePolicy SET ownerId = ownerId WHERE ownerId = ${ownerId}`
    const certificationPolicy = await transaction.compliancePolicy.findUnique({ where: { ownerId }, select: { operatorIds: true, recoveryPointObjectiveMinutes: true, recoveryTimeObjectiveMinutes: true } })
    assertRestoreCertificationPolicy(certificationPolicy, actorId, recoveryWindow, restoreMinutes)
    const verifiedAt = new Date()
    const verified = await transaction.backupManifest.update({ where: { id: backupId }, data: { verifiedAt, restoredAt: verifiedAt, status: 'RESTORE_VERIFIED' } })
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'RESTORE_VERIFIED', reason, objectType: 'BackupManifest', objectId: backupId, after: { verifiedAt: verifiedAt.toISOString(), reportedRestoreMinutes: measuredRestoreMinutes, observedRestoreMinutes, certifiedRestoreMinutes: restoreMinutes, objectCount: isolatedObjects.objectCount, databaseCounts: isolatedDatabase } })
    return { ...verified, isolatedRestore: true, isolatedDatabase, isolatedObjects }
  })
}

function toMapping(row: { accountNumber: number; accountName: string; accountType: string; normalBalance: string; hgbPosition: string; eBilanzPosition: string; vatCode: string | null; active: boolean }): AccountMapping {
  return { accountNumber: row.accountNumber, name: row.accountName, accountType: row.accountType as AccountMapping['accountType'], normalBalance: row.normalBalance as AccountMapping['normalBalance'], hgbPosition: row.hgbPosition, eBilanzPosition: row.eBilanzPosition, vatCode: row.vatCode ?? undefined, active: row.active }
}
function toPublicMapping(row: Parameters<typeof toMapping>[0] & { id: string; ownerId: string; chartId: string; effectiveFrom: Date; effectiveTo: Date | null }) { return { id: row.id, ownerId: row.ownerId, chartId: row.chartId, effectiveFrom: dateOnly(row.effectiveFrom), effectiveTo: row.effectiveTo ? dateOnly(row.effectiveTo) : null, ...toMapping(row) } }

export function validateAuthoritativeProfile(profile: unknown) {
  const issues = validateCompanyProfile(profile)
  if (issues.length) throw new ComplianceRuntimeError(issues.join('; '))
  return profile as CompanyProfile
}

export function complianceError(error: unknown) {
  if (error instanceof ComplianceRuntimeError) return Response.json({ success: false, error: error.message }, { status: error.status })
  if (error instanceof AccountingValidationError) return Response.json({ success: false, issues: error.issues }, { status: 400 })
  if (error instanceof SyntaxError) return Response.json({ success: false, error: 'Invalid JSON payload' }, { status: 400 })
  throw error
}
