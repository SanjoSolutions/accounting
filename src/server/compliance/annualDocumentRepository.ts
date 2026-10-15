import 'server-only'

import { randomUUID } from 'node:crypto'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { canonicalJson } from '@/core/compliance/auditExport'
import { ANNUAL_DOCUMENT_RENDERER, annualDocumentFiles, hashDocument, readAnnualDocumentInput, type AnnualDocumentMode, type AnnualDocumentSource, type DisclosureSelection } from '@/core/compliance/annualDocuments'
import type { AnnualAccountsPackage } from '@/core/compliance/annualAccounts'
import type { HgbCloseReadinessInput } from '@/core/hgbClose'
import type { GmbhEquityResultSchedule } from '@/core/hgbWorkpapers'
import { prisma } from '@/server/persistence/client'
import { getDocumentStorage } from '@/server/storage'
import { requireCurrentReadyHgbClose } from '@/server/hgbCloseRepository'
import { appendAuditEvent } from './auditPersistence'
import { persistComplianceObject } from './objectStorage'
import { ComplianceRuntimeError } from './runtime'

const objectType = 'AnnualDocumentBundle'
const noSource = () => new ComplianceRuntimeError('Approved annual package not found', 404)
const conflict = (message: string) => new ComplianceRuntimeError(message, 409)

async function approvedSource(ownerId: string, packageId: string) {
  const record = await prisma.compliancePackage.findFirst({ where: { id: packageId, ownerId, kind: 'ANNUAL_ACCOUNTS', status: { in: ['APPROVED', 'SUPERSEDED'] } } })
  if (!record?.storageKey || !record.approvedBy || !record.approvedAt || !record.fiscalPeriodId) throw noSource()
  const artifact = await prisma.retainedArtifact.findFirst({ where: { ownerId, objectType: 'CompliancePackage', objectId: record.id, version: record.version, disposedAt: null, storageDeletedAt: null } })
  if (!artifact || artifact.storageKey !== record.storageKey) throw conflict('Annual package retention binding is unavailable')
  const bytes = await verifiedBytes(record.storageKey, artifact.contentHash)
  if (bytes.toString('utf8') !== record.payload) throw conflict('Annual package retained bytes differ from the database')
  let annual: AnnualAccountsPackage; let input: AnnualDocumentSource['input']
  try {
    annual = JSON.parse(record.payload)
    const expected = hashDocument(canonicalJson({ kind: record.kind, fiscalPeriodId: record.fiscalPeriodId, authorityRef: record.authorityRef, payload: annual }))
    if (expected !== record.checksum || annual.version !== record.version) throw new Error('Package envelope checksum or version is invalid')
    input = readAnnualDocumentInput(annual)
  } catch { throw conflict('Annual package identity, reconciliation or checksum is invalid') }
  if (input.profile.tenantId !== ownerId) throw conflict('Annual package tenant binding is invalid')
  return { record, artifact, annual, input }
}

async function currentSource(ownerId: string, packageId: string): Promise<AnnualDocumentSource> {
  const { record, annual, input } = await approvedSource(ownerId, packageId)
  const period = await prisma.fiscalYear.findFirst({ where: { id: record.fiscalPeriodId!, ownerId } })
  if (!period || period.year !== input.fiscalYear || period.startsAt.toISOString().slice(0, 10) !== input.fiscalPeriodStart || period.endsAt.toISOString().slice(0, 10) !== input.fiscalPeriodEnd) throw conflict('Annual fiscal-period binding is invalid')
  const run = await requireCurrentReadyHgbClose(prisma, ownerId, period)
  const close = JSON.parse(run.payload) as { input: HgbCloseReadinessInput; readiness: { size: string; notesRequired: boolean } }
  if (close.input.annualAccountsPackageId !== packageId || close.input.annualAccountsChecksum !== record.checksum || close.readiness.size !== input.profile.size) throw conflict('The selected annual version does not match the current approved close')
  const equityRecord = await prisma.hgbWorkpaperRecord.findFirst({ where: { ownerId, fiscalPeriodId: period.id, kind: 'GMBH_EQUITY_AND_RESULT', status: 'REVIEWED' }, orderBy: { version: 'desc' } })
  if (!equityRecord) throw conflict('Reviewed equity and result information is unavailable')
  const equity = (JSON.parse(equityRecord.payload) as { schedule: GmbhEquityResultSchedule }).schedule
  if (equity.type !== 'GMBH_EQUITY_RESULT' || equity.resultCents !== input.incomeStatement.find(line => line.code === 'NET_INCOME')?.amountCents) throw conflict('Reviewed result does not reconcile to the selected annual statement')
  return {
    packageId: record.id, packageVersion: record.version, packageChecksum: record.checksum, annual, input,
    approvedBy: record.approvedBy!, approvedAt: record.approvedAt!.toISOString(),
    close: { id: run.id, checksum: run.checksum, notesRequired: close.readiness.notesRequired, signatures: close.input.managingDirectorSignatures!.map(signature => ({ ...signature })), resolutionId: close.input.shareholderResolutionId! },
    equity: { resultCents: equity.resultCents, shareCapitalCents: equity.shareCapitalCents, section5aReserveApplicable: equity.section5aReserveApplicable, ...(equity.reserveCalculationEvidenceId ? { reserveCalculationEvidenceId: equity.reserveCalculationEvidenceId } : {}), evidenceId: equity.evidenceId },
  }
}

export async function annualDocumentOptions(ownerId: string, packageId: string) {
  const { record, input } = await approvedSource(ownerId, packageId)
  const artifacts = await prisma.retainedArtifact.findMany({ where: { ownerId, objectType, objectId: packageId, disposedAt: null, storageDeletedAt: null }, orderBy: { version: 'desc' }, select: { id: true, version: true, provenance: true, createdAt: true, contentHash: true } })
  return { packageId, packageVersion: record.version, checksum: record.checksum, company: input.profile.legalName, fiscalYear: input.fiscalYear, size: input.profile.size, notes: input.notes, policies: input.policies, artifacts }
}

export async function createAnnualDocumentBundle(ownerId: string, actorId: string, packageId: string, request: { mode?: unknown; expectedChecksum?: unknown; selection?: DisclosureSelection }) {
  if (request.mode !== 'annual' && request.mode !== 'manual') throw new ComplianceRuntimeError('Choose annual or manual document mode')
  const mode: AnnualDocumentMode = request.mode
  const source = await currentSource(ownerId, packageId)
  if (source.packageChecksum !== request.expectedChecksum) throw conflict('The selected source checksum changed; reload the approved version')
  const selection = mode === 'manual' && request.selection ? {
    noteIndexes: request.selection.noteIndexes, policyIndexes: request.selection.policyIndexes,
    establishedOn: request.selection.establishedOn, confirmedCompleteAndMinimized: request.selection.confirmedCompleteAndMinimized,
  } : undefined
  let files: Record<string, string>
  try { files = annualDocumentFiles(source, mode, selection) } catch (error) { throw conflict(error instanceof Error ? error.message : 'Invalid document selection') }
  const createdAt = new Date()
  const manifest = {
    format: ANNUAL_DOCUMENT_RENDERER, mode, sourcePackageId: packageId, sourceVersion: source.packageVersion, sourceChecksum: source.packageChecksum,
    sourceCloseId: source.close.id, sourceCloseChecksum: source.close.checksum,
    exportedAt: createdAt.toISOString(), exportedBy: actorId, approval: { by: source.approvedBy, at: source.approvedAt },
    status: 'EXPORTED_NOT_FILED', ...(mode === 'manual' ? { disclosureSelection: selection, review: 'USER_CONFIRMED_COMPLETE_AND_MINIMIZED' } : {}),
    files: Object.fromEntries(Object.entries(files).map(([name, value]) => [name, { sha256: hashDocument(value), bytes: Buffer.byteLength(value) }])),
  }
  files['manifest.json'] = canonicalJson(manifest)
  const content = zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, [strToU8(value), { mtime: new Date('2000-01-01T00:00:00Z') }]])), { level: 6 })
  const id = randomUUID()
  const storageKey = await persistComplianceObject({ ownerId, category: 'closing-snapshots', objectId: id, extension: 'zip', content, contentType: 'application/zip', fileName: `${mode}-${source.input.fiscalYear}-v${source.packageVersion}.zip` })
  try {
    return await prisma.$transaction(async transaction => {
      // Close the read/write race: a new close, approval or source change may not be stamped as this export.
      const approved = await transaction.compliancePackage.findFirst({ where: { id: packageId, ownerId, kind: 'ANNUAL_ACCOUNTS', status: 'APPROVED', checksum: source.packageChecksum } })
      if (!approved || approved.approvedBy !== source.approvedBy || approved.approvedAt?.toISOString() !== source.approvedAt) throw conflict('The package approval changed while creating the export')
      const run = await requireCurrentReadyHgbClose(transaction, ownerId, { id: approved.fiscalPeriodId!, year: source.input.fiscalYear })
      if (run.id !== source.close.id || run.checksum !== source.close.checksum) throw conflict('The close changed while creating the export')
      const latest = await transaction.retainedArtifact.findFirst({ where: { ownerId, objectType, objectId: packageId }, orderBy: { version: 'desc' }, select: { version: true } })
      const periodEndsAt = new Date(`${source.input.fiscalPeriodEnd}T23:59:59.999Z`); const retainUntil = new Date(periodEndsAt); retainUntil.setUTCFullYear(retainUntil.getUTCFullYear() + 10)
      const artifact = await transaction.retainedArtifact.create({ data: { id, ownerId, objectType, objectId: packageId, version: (latest?.version ?? 0) + 1, retentionClass: 'ACCOUNTING_RECORDS', contentHash: hashDocument(content), provenance: mode, storageKey, periodEndsAt, retainUntil } })
      await appendAuditEvent(transaction, { ownerId, actorId, action: 'EXPORT_CREATED', reason: mode === 'manual' ? 'Explicitly reviewed minimized manual disclosure export; no external submission' : 'Printable immutable approved annual-account export', objectType, objectId: artifact.id, after: { sourcePackageId: packageId, sourceChecksum: source.packageChecksum, contentHash: artifact.contentHash, mode, status: 'EXPORTED_NOT_FILED' } })
      return { id: artifact.id, version: artifact.version, provenance: mode, createdAt: artifact.createdAt, contentHash: artifact.contentHash }
    })
  } catch (error) { await getDocumentStorage().delete(storageKey).catch(() => undefined); throw error }
}

async function verifiedBytes(storageKey: string, expectedHash: string) {
  const storage = getDocumentStorage()
  if (!await storage.exists(storageKey)) throw conflict('Retained document bytes are unavailable')
  const content = await storage.read(storageKey)
  if (hashDocument(content) !== expectedHash) throw conflict('Retained document fixity check failed')
  return content
}

export async function downloadAnnualDocument(ownerId: string, actorId: string, packageId: string, artifactId: string, file: string) {
  const { record } = await approvedSource(ownerId, packageId)
  const artifact = await prisma.retainedArtifact.findFirst({ where: { id: artifactId, ownerId, objectType, objectId: packageId, disposedAt: null, storageDeletedAt: null } })
  if (!artifact?.storageKey) throw new ComplianceRuntimeError('Retained document export not found', 404)
  const bytes = await verifiedBytes(artifact.storageKey, artifact.contentHash)
  let content: Uint8Array = bytes
  const allowed = artifact.provenance === 'manual' ? ['einreichung.html', 'ANLEITUNG.txt', 'manifest.json'] : ['jahresabschluss.html', 'abschluss.json', 'manifest.json']
  if (file !== 'bundle' && !allowed.includes(file)) throw new ComplianceRuntimeError('Document file not found', 404)
  try {
    const files = unzipSync(bytes)
    const manifest = JSON.parse(strFromU8(files['manifest.json']))
    if (manifest.sourcePackageId !== packageId || manifest.sourceChecksum !== record.checksum || manifest.sourceVersion !== record.version || manifest.mode !== artifact.provenance) throw new Error('Invalid binding')
    for (const name of allowed.filter(name => name !== 'manifest.json')) if (!files[name] || hashDocument(files[name]) !== manifest.files[name]?.sha256 || files[name].byteLength !== manifest.files[name]?.bytes) throw new Error('Invalid member hash')
    if (Object.keys(files).some(name => !allowed.includes(name))) throw new Error('Unexpected document member')
    if (file !== 'bundle') content = files[file]
  } catch { throw conflict('Retained document manifest or source binding is invalid') }
  const contentHash = hashDocument(content)
  await prisma.$transaction(transaction => appendAuditEvent(transaction, { ownerId, actorId, action: 'EXPORT_DOWNLOADED', reason: 'Authenticated immutable annual document download; archive as exported', objectType, objectId: artifact.id, after: { sourcePackageId: packageId, sourceVersion: record.version, file, contentHash } }))
  return { content, contentHash, fileName: file === 'bundle' ? `${artifact.provenance}-v${record.version}-${artifact.id}.zip` : file, contentType: file === 'bundle' ? 'application/zip' : file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8' }
}
