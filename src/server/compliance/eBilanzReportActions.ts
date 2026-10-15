import 'server-only'

import type { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/server/persistence/client'
import { getDocumentStorage } from '@/server/storage'
import { appendAuditEvent } from './auditPersistence'
import { assertCurrentEBalanceReport } from './eBilanzExportRepository'
import { ComplianceRuntimeError } from './runtime'
import { sha256 } from './retention'

export async function approveEBalanceReport(ownerId: string, actorId: string, input: Record<string, unknown>) {
  if (typeof input.reportId !== 'string' || typeof input.reportChecksum !== 'string' || typeof input.reason !== 'string' || !input.reason.trim() || input.confirmed !== true) {
    throw new ComplianceRuntimeError('Confirm the exact report ID, checksum and review reason.')
  }
  const { reportId, reportChecksum, reason } = input
  return prisma.$transaction(async transaction => {
    const report = await transaction.eBalanceLifecycleReport.findFirst({ where: { id: reportId, ownerId } })
    if (!report) throw new ComplianceRuntimeError('Report not found.', 404)
    if (report.reportChecksum !== reportChecksum) throw new ComplianceRuntimeError('The reviewed report checksum does not match.', 409)
    const latest = await transaction.eBalanceLifecycleReport.findFirst({ where: { ownerId, fiscalYearId: report.fiscalYearId }, orderBy: { version: 'desc' } })
    if (latest?.id !== report.id) throw new ComplianceRuntimeError('A superseded report cannot be approved.', 409)
    try { await assertCurrentEBalanceReport(transaction, ownerId, report) }
    catch (error) { throw new ComplianceRuntimeError(error instanceof Error ? error.message : 'Report sources are stale.', 409) }
    await retainedReportBytes(transaction, ownerId, report)
    if (report.approvedAt) return report
    if (!['PREPARED', 'EXPORTED'].includes(report.status)) throw new ComplianceRuntimeError('The report cannot be approved in its current state.', 409)
    const approvedAt = new Date()
    const approved = await transaction.eBalanceLifecycleReport.update({ where: { id: report.id }, data: { status: 'APPROVED', approvedBy: actorId, approvedAt } })
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'E_BILANZ_REPORT_APPROVED', reason: reason.trim(), objectType: 'EBalanceLifecycleReport', objectId: report.id,
      after: { reportChecksum, closeGenerationId: report.closeGenerationId, version: report.version, approvedAt: approvedAt.toISOString(), scope: 'LOCAL_REPORT_REVIEW', officialAcceptance: 'NOT_VALIDATED' } })
    return approved
  })
}

/** Historical bytes remain accessible even when their source close is stale. */
export async function downloadEBalanceReport(ownerId: string, actorId: string, reportId: string) {
  return prisma.$transaction(async transaction => {
    const report = await transaction.eBalanceLifecycleReport.findFirst({ where: { id: reportId, ownerId } })
    if (!report) throw new ComplianceRuntimeError('Report not found.', 404)
    const { content, artifact } = await retainedReportBytes(transaction, ownerId, report)
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'E_BILANZ_REPORT_ACCESSED', reason: 'Authenticated retained report download', objectType: 'EBalanceLifecycleReport', objectId: report.id,
      after: { reportChecksum: report.reportChecksum, artifactId: artifact.id, contentHash: artifact.contentHash, version: report.version } })
    const zip = report.storageKey.endsWith('.zip')
    return { content, contentType: zip ? 'application/zip' : 'application/xml', fileName: `e-bilanz-v${report.version}.${zip ? 'zip' : 'xml'}` }
  })
}

async function retainedReportBytes(transaction: Prisma.TransactionClient, ownerId: string, report: {
  id: string; fiscalYearId: string; storageKey: string; reportXml: string; reportChecksum: string
}) {
  const artifact = await transaction.retainedArtifact.findFirst({ where: {
    ownerId, storageKey: report.storageKey, disposedAt: null, storageDeletedAt: null,
    OR: [{ objectType: 'EBalanceLifecycleReport', objectId: report.id }, { objectType: 'TaxExport', objectId: `E-BILANZ:${report.fiscalYearId}` }],
  } })
  if (!artifact) throw new ComplianceRuntimeError('Retained report artifact is unavailable.', 409)
  const content = await getDocumentStorage().read(report.storageKey)
  if (sha256(content) !== artifact.contentHash || sha256(report.reportXml) !== report.reportChecksum) throw new ComplianceRuntimeError('Retained report checksum mismatch.', 409)
  return { content, artifact }
}
