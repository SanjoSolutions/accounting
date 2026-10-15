import 'server-only'

import { randomUUID } from 'node:crypto'
import { canonicalJson } from '@/core/compliance/auditExport'
import { selectTaxonomy, type TaxonomyRelease } from '@/core/compliance/eBilanzLifecycle'
import { prisma } from '@/server/persistence/client'
import { getDocumentStorage } from '@/server/storage'
import { appendAuditEvent } from './auditPersistence'
import { ComplianceRuntimeError } from './runtime'
import { createEBalanceReconciliationChecksum, taxonomyArchiveStorageKey, verifyTaxonomyArchive } from './eBilanzIntegration'
import { requireCurrentFiscalCloseGeneration } from '@/server/fiscalCloseGeneration'
import { assertCurrentEBalanceReport, prepareAuthoritativeEBalanceExport, recordTaxBalanceReconciliation } from './eBilanzExportRepository'
import { retainEBalanceReport } from './eBilanzReportStore'

function required(value: unknown, label: string) { if (typeof value !== 'string' || !value.trim()) throw new ComplianceRuntimeError(`${label} is required`); return value.trim() }
function dateOnly(value: Date) { return value.toISOString().slice(0, 10) }
function taxonomyFromRecord(row: { version: string; validFrom: Date; validThrough: Date; gaapNamespace: string; gcdNamespace: string; entryPoint: string; archiveSha256: string; successorVersion: string | null }): TaxonomyRelease { return { version: row.version, validForFiscalPeriodsStartingFrom: dateOnly(row.validFrom), validForFiscalPeriodsStartingThrough: dateOnly(row.validThrough), gaapNamespace: row.gaapNamespace, gcdNamespace: row.gcdNamespace, entryPoint: row.entryPoint, archiveSha256: row.archiveSha256, ...(row.successorVersion ? { successorVersion: row.successorVersion } : {}) } }

export function assertTaxonomyAdministrator(actorId: string, configured = process.env.TAXONOMY_ADMIN_IDS) {
  const admins = configured?.split(',').map(value => value.trim()).filter(Boolean) ?? []
  if (!admins.includes(actorId)) throw new ComplianceRuntimeError('Official taxonomy registry changes require an explicitly configured administrator', 403)
}

export async function registerEBalanceTaxonomy(actorId: string, input: Record<string, unknown>) {
  assertTaxonomyAdministrator(actorId)
  const archiveBase64 = required(input.archiveBase64, 'archiveBase64')
  const archive = Buffer.from(archiveBase64, 'base64')
  if (!archive.length || archive.toString('base64').replace(/=+$/, '') !== archiveBase64.replace(/=+$/, '')) throw new ComplianceRuntimeError('archiveBase64 must contain canonical nonempty base64 bytes')
  const release: TaxonomyRelease = {
    version: required(input.version, 'version'), validForFiscalPeriodsStartingFrom: required(input.validFrom, 'validFrom'), validForFiscalPeriodsStartingThrough: required(input.validThrough, 'validThrough'),
    gaapNamespace: required(input.gaapNamespace, 'gaapNamespace'), gcdNamespace: required(input.gcdNamespace, 'gcdNamespace'), entryPoint: required(input.entryPoint, 'entryPoint'), archiveSha256: required(input.archiveSha256, 'archiveSha256').toLowerCase(),
    ...(typeof input.successorVersion === 'string' && input.successorVersion.trim() ? { successorVersion: input.successorVersion.trim() } : {}),
  }
  selectTaxonomy([release], release.validForFiscalPeriodsStartingFrom, release.version)
  verifyTaxonomyArchive(release, archive)
  // Each registration owns a unique archive, so a duplicate/concurrent database
  // failure can only clean up the bytes written by this attempt.
  const storageKey = taxonomyArchiveStorageKey(release, randomUUID())
  await getDocumentStorage().write(storageKey, archive, { contentType: 'application/zip', fileName: `german-gaap-taxonomy-${release.version}.zip` })
  try {
    return await prisma.$transaction(async transaction => {
      const record = await transaction.eBalanceTaxonomyRelease.create({ data: { version: release.version, validFrom: new Date(`${release.validForFiscalPeriodsStartingFrom}T00:00:00Z`), validThrough: new Date(`${release.validForFiscalPeriodsStartingThrough}T23:59:59.999Z`), gaapNamespace: release.gaapNamespace, gcdNamespace: release.gcdNamespace, entryPoint: release.entryPoint, archiveSha256: release.archiveSha256, archiveStorageKey: storageKey, successorVersion: release.successorVersion ?? null, compatibility: canonicalJson(input.compatibility ?? {}), registeredBy: actorId } })
      await appendAuditEvent(transaction, { ownerId: 'SYSTEM', actorId, action: 'E_BILANZ_TAXONOMY_REGISTERED', reason: required(input.reason, 'reason'), objectType: 'EBalanceTaxonomyRelease', objectId: record.version, after: { archiveSha256: record.archiveSha256, validFrom: release.validForFiscalPeriodsStartingFrom, validThrough: release.validForFiscalPeriodsStartingThrough } })
      return record
    })
  } catch (error) { await getDocumentStorage().delete(storageKey).catch(() => undefined); throw error }
}

export async function recordEBalanceReconciliation(ownerId: string, actorId: string, input: Record<string, unknown>) {
  const fiscalYearId = required(input.fiscalYearId, 'fiscalYearId'); const kind = required(input.kind, 'kind')
  if (kind === 'TAX_BALANCE') {
    try { return await recordTaxBalanceReconciliation(ownerId, actorId, input) }
    catch (error) { throw new ComplianceRuntimeError(error instanceof Error ? error.message : 'Invalid tax-balance approval', 409) }
  }
  if (!['ADJUSTMENT', 'SPECIAL_BALANCE', 'SUPPLEMENTARY_BALANCE'].includes(kind)) throw new ComplianceRuntimeError('Unsupported E-Bilanz reconciliation kind')
  const period = await prisma.fiscalYear.findFirst({ where: { id: fiscalYearId, ownerId }, select: { id: true } }); if (!period) throw new ComplianceRuntimeError('Fiscal period not found', 404)
  if (!Array.isArray(input.evidenceIds) || !input.evidenceIds.length || input.evidenceIds.some(value => typeof value !== 'string' || !value.trim())) throw new ComplianceRuntimeError('Reconciliation evidenceIds must contain nonblank IDs')
  const payload = canonicalJson(input.payload); const checksum = createEBalanceReconciliationChecksum(fiscalYearId, kind, payload); const id = required(input.id, 'id')
  return prisma.$transaction(async transaction => {
    const record = await transaction.eBalanceReconciliationRecord.create({ data: { id, ownerId, fiscalYearId, kind, payload, checksum, evidenceIds: canonicalJson(input.evidenceIds), approvedBy: actorId, approvedAt: new Date() } })
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'E_BILANZ_RECONCILIATION_RECORDED', reason: required(input.reason, 'reason'), objectType: 'EBalanceReconciliationRecord', objectId: id, after: { fiscalYearId, kind, checksum } })
    return record
  })
}

export async function getEBalanceLifecycleOverview(ownerId: string, fiscalYearId?: string) {
  const [taxonomies, reports, reconciliations] = await prisma.$transaction([
    prisma.eBalanceTaxonomyRelease.findMany({ orderBy: { validFrom: 'desc' } }),
    prisma.eBalanceLifecycleReport.findMany({ where: { ownerId, ...(fiscalYearId ? { fiscalYearId } : {}) }, orderBy: { version: 'desc' } }),
    prisma.eBalanceReconciliationRecord.findMany({ where: { ownerId, ...(fiscalYearId ? { fiscalYearId } : {}) }, orderBy: { createdAt: 'asc' } }),
  ])
  if (!fiscalYearId) return { taxonomies: taxonomies.map(taxonomyFromRecord), reports, reconciliations, closeEvidence: null }
  const fiscalYear = await prisma.fiscalYear.findFirst({ where: { id: fiscalYearId, ownerId }, select: { id: true, year: true, status: true, lockedAt: true, closingSnapshot: true } })
  if (!fiscalYear) return { taxonomies: taxonomies.map(taxonomyFromRecord), reports: [], reconciliations: [], closeEvidence: null }
  let currentCloseGenerationId: string | null = null
  let sourceStatus: 'CURRENT' | 'STALE' | 'NOT_LOCKED' = fiscalYear.status === 'CLOSED' ? 'STALE' : 'NOT_LOCKED'
  let issue: string | null = fiscalYear.status === 'CLOSED' ? 'The exact locked HGB close could not be verified.' : 'The fiscal year is not locked.'
  if (fiscalYear.status === 'CLOSED') {
    try {
      const generation = await requireCurrentFiscalCloseGeneration(prisma, ownerId, fiscalYear)
      currentCloseGenerationId = generation.id; sourceStatus = 'CURRENT'; issue = null
    } catch (error) { issue = error instanceof Error ? error.message : issue }
  }
  let currentReportId: string | null = null
  const candidate = sourceStatus === 'CURRENT' ? reports.find(report => report.closeGenerationId === currentCloseGenerationId) : undefined
  if (candidate) {
    try { await assertCurrentEBalanceReport(prisma, ownerId, candidate); currentReportId = candidate.id }
    catch { /* Prior approvals and internal evidence remain visible as stale. */ }
  }
  return {
    taxonomies: taxonomies.map(taxonomyFromRecord),
    // A report version is current only while it is both bound to the exact
    // authoritative close generation and is that generation's newest report.
    // Earlier versions remain immutable evidence, but are superseded and must
    // never be mistaken for the dataset that should be revalidated/submitted.
    reports: reports.map(report => ({ ...report, sourceStatus: report.id === currentReportId ? 'CURRENT' : 'STALE' })),
    reconciliations,
    closeEvidence: { fiscalYearId, currentCloseGenerationId, sourceStatus, issue },
  }
}

export async function prepareEBalanceLifecycleReport(ownerId: string, actorId: string, input: Record<string, unknown>) {
  const reason = required(input.reason, 'reason')
  const fiscalYearId = required(input.fiscalYearId, 'fiscalYearId')
  const period = await prisma.fiscalYear.findFirst({ where: { id: fiscalYearId, ownerId }, select: { id: true, year: true, startsAt: true, endsAt: true, status: true, lockedAt: true, closingSnapshot: true } })
  if (!period) throw new ComplianceRuntimeError('Fiscal period not found', 404)
  let closeGeneration
  try { closeGeneration = await requireCurrentFiscalCloseGeneration(prisma, ownerId, period) }
  catch (error) { throw new ComplianceRuntimeError(error instanceof Error ? error.message : 'A current exact fiscal close generation is required', 409) }
  let prepared: Awaited<ReturnType<typeof prepareAuthoritativeEBalanceExport>>
  try { prepared = await prepareAuthoritativeEBalanceExport(ownerId, fiscalYearId, { taxonomyVersion: typeof input.taxonomyVersion === 'string' ? input.taxonomyVersion : undefined }) }
  catch (error) { throw new ComplianceRuntimeError(error instanceof Error ? error.message : 'Invalid E-Bilanz preparation', 409) }
  const { xml, reportChecksum } = prepared
  const id = randomUUID(); const storageKey = `tax-exports/${encodeURIComponent(ownerId)}/e-bilanz-lifecycle-${id}.xbrl`; await getDocumentStorage().write(storageKey, Buffer.from(xml, 'utf8'), { contentType: 'application/xml', fileName: `e-bilanz-${dateOnly(period.endsAt)}-${id}.xml` })
  try {
    return await prisma.$transaction(async transaction => {
      const currentPeriod = await transaction.fiscalYear.findFirst({ where: { id: fiscalYearId, ownerId }, select: { id: true, year: true, status: true, lockedAt: true, closingSnapshot: true } })
      if (!currentPeriod) throw new ComplianceRuntimeError('Fiscal period not found', 404)
      let currentCloseGeneration
      try { currentCloseGeneration = await requireCurrentFiscalCloseGeneration(transaction, ownerId, currentPeriod) }
      catch (error) { throw new ComplianceRuntimeError(error instanceof Error ? error.message : 'The fiscal close generation became stale', 409) }
      if (currentCloseGeneration.id !== closeGeneration.id) throw new ComplianceRuntimeError('The fiscal close generation changed during E-Bilanz preparation', 409)
      const result = await retainEBalanceReport(transaction, { ownerId, actorId, id, prepared, storageKey, storageChecksum: reportChecksum, status: 'PREPARED', reason })
      if (!result.created) await getDocumentStorage().delete(storageKey)
      return result.report
    })
  } catch (error) { await getDocumentStorage().delete(storageKey).catch(() => undefined); throw error }
}
