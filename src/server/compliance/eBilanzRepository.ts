import 'server-only'

import { randomUUID } from 'node:crypto'
import { canonicalJson } from '@/core/compliance/auditExport'
import { createAssetSchedules, type AssetEvent, type FixedAsset } from '@/core/compliance/assetsInventory'
import { createEBalanceReport, selectTaxonomy, type EBalanceSupportingBalance, type TaxAdjustment, type TaxonomyRelease } from '@/core/compliance/eBilanzLifecycle'
import { prisma } from '@/server/persistence/client'
import { getDocumentStorage } from '@/server/storage'
import { appendAuditEvent } from './auditPersistence'
import { ComplianceRuntimeError } from './runtime'
import { allowUnqualifiedEBalanceDrafts, assertEBalanceDraftReadiness, canonicalXbrlSerializer, createEBalanceLedgerFacts, createEBalanceReconciliationChecksum, deriveAuthoritativeEBalanceProfile, eBalanceLifecycleReadiness, taxonomyArchiveStorageKey, verifyTaxonomyArchive } from './eBilanzIntegration'

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
    prisma.eBalanceLifecycleReport.findMany({ where: { ownerId, ...(fiscalYearId ? { fiscalYearId } : {}) }, orderBy: { createdAt: 'desc' } }),
    prisma.eBalanceReconciliationRecord.findMany({ where: { ownerId, ...(fiscalYearId ? { fiscalYearId } : {}) }, orderBy: { createdAt: 'asc' } }),
  ])
  return { taxonomies: taxonomies.map(taxonomyFromRecord), reports, reconciliations }
}

export async function prepareEBalanceLifecycleReport(ownerId: string, actorId: string, input: Record<string, unknown>) {
  const fiscalYearId = required(input.fiscalYearId, 'fiscalYearId')
  const period = await prisma.fiscalYear.findFirst({ where: { id: fiscalYearId, ownerId }, select: { id: true, startsAt: true, endsAt: true, status: true } })
  if (!period) throw new ComplianceRuntimeError('Fiscal period not found', 404)
  const profileVersion = await prisma.companyProfileVersion.findFirst({ where: { ownerId, effectiveFrom: { lte: period.endsAt }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: period.endsAt } }] }, orderBy: { effectiveFrom: 'desc' } })
  if (!profileVersion) throw new ComplianceRuntimeError('No effective authoritative company profile covers the fiscal period')
  const profile = deriveAuthoritativeEBalanceProfile(ownerId, period, JSON.parse(profileVersion.payload))
  const taxonomyRows = await prisma.eBalanceTaxonomyRelease.findMany({ orderBy: { validFrom: 'asc' } }); const registry = taxonomyRows.map(taxonomyFromRecord)
  const taxonomy = selectTaxonomy(registry, dateOnly(period.startsAt), typeof input.taxonomyVersion === 'string' ? input.taxonomyVersion : undefined)
  const [accounts, assets, events, reconciliationRows] = await Promise.all([
    prisma.ledgerAccount.findMany({ where: { ownerId }, include: { journalLines: { where: { journalEntry: { fiscalYearId, state: 'POSTED' } } } }, orderBy: { number: 'asc' } }),
    prisma.fixedAssetRecord.findMany({ where: { ownerId }, orderBy: { createdAt: 'asc' } }), prisma.assetEventRecord.findMany({ where: { ownerId }, orderBy: [{ assetId: 'asc' }, { sequence: 'asc' }] }),
    prisma.eBalanceReconciliationRecord.findMany({ where: { ownerId, fiscalYearId }, orderBy: { createdAt: 'asc' } }),
  ])
  let facts: ReturnType<typeof createEBalanceLedgerFacts>
  try { facts = createEBalanceLedgerFacts(accounts) }
  catch (error) { throw new ComplianceRuntimeError(error instanceof Error ? error.message : 'E-Bilanz ledger facts are invalid') }
  const adjustments = reconciliationRows.filter(row => row.kind === 'ADJUSTMENT').map(row => JSON.parse(row.payload) as TaxAdjustment)
  const supporting = (kind: string) => reconciliationRows.find(row => row.kind === kind)
  const schedules = createAssetSchedules(ownerId, assets.map(row => JSON.parse(row.payload) as FixedAsset), events.map(row => JSON.parse(row.payload) as AssetEvent), { start: dateOnly(period.startsAt), end: dateOnly(period.endsAt) })
  const readiness = eBalanceLifecycleReadiness({ profile, taxonomy, fiscalYearStatus: period.status, facts, reconciliationKinds: reconciliationRows.map(row => row.kind), assetScheduleReady: true, ericQualified: process.env.ERIC_QUALIFIED === 'true' })
  try { assertEBalanceDraftReadiness(readiness, allowUnqualifiedEBalanceDrafts()) }
  catch (error) { throw new ComplianceRuntimeError(error instanceof Error ? error.message : 'E-Bilanz lifecycle is not ready') }
  const attachments = { ...schedules.eBalanceAttachments, ...(supporting('SPECIAL_BALANCE') ? { specialBalance: JSON.parse(supporting('SPECIAL_BALANCE')!.payload) as EBalanceSupportingBalance } : {}), ...(supporting('SUPPLEMENTARY_BALANCE') ? { supplementaryBalance: JSON.parse(supporting('SUPPLEMENTARY_BALANCE')!.payload) as EBalanceSupportingBalance } : {}) }
  const report = createEBalanceReport(profile, taxonomy, facts, adjustments, attachments, canonicalXbrlSerializer())
  const id = randomUUID(); const storageKey = `tax-exports/${encodeURIComponent(ownerId)}/e-bilanz-lifecycle-${id}.xml`; await getDocumentStorage().write(storageKey, Buffer.from(report.transmittedBytes), { contentType: 'application/xml', fileName: `e-bilanz-${dateOnly(period.endsAt)}-${id}.xml` })
  try {
    return await prisma.$transaction(async transaction => {
      const latest = await transaction.eBalanceLifecycleReport.findFirst({ where: { ownerId, fiscalYearId }, orderBy: { version: 'desc' } }); const version = (latest?.version ?? 0) + 1
      const record = await transaction.eBalanceLifecycleReport.create({ data: { id, ownerId, fiscalYearId, version, status: 'PREPARED', taxonomyVersion: taxonomy.version, profileSnapshot: canonicalJson(profile), reportPayload: canonicalJson(report.payload), reportXml: report.content, reportChecksum: report.checksum, storageKey, supersedesId: latest?.id ?? null, createdBy: actorId } })
      const retainUntil = new Date(period.endsAt); retainUntil.setUTCFullYear(retainUntil.getUTCFullYear() + 10)
      await transaction.retainedArtifact.create({ data: { ownerId, objectType: 'EBalanceLifecycleReport', objectId: id, version, retentionClass: 'TAX_RECORD', contentHash: report.checksum, provenance: `taxonomy:${taxonomy.version}`, storageKey, periodEndsAt: period.endsAt, retainUntil } })
      await appendAuditEvent(transaction, { ownerId, actorId, action: 'E_BILANZ_REPORT_PREPARED', reason: required(input.reason, 'reason'), objectType: 'EBalanceLifecycleReport', objectId: id, after: { fiscalYearId, version, taxonomyVersion: taxonomy.version, reportChecksum: report.checksum, readiness } })
      return record
    })
  } catch (error) { await getDocumentStorage().delete(storageKey).catch(() => undefined); throw error }
}
