import 'server-only'

import type { Prisma } from '@/generated/prisma/client'
import { canonicalJson } from '@/core/compliance/auditExport'
import { appendAuditEvent } from './auditPersistence'
import { assertCurrentEBalanceExport, type prepareAuthoritativeEBalanceExport, serializePreparedEBalanceEvidence } from './eBilanzExportRepository'
import { retentionDeadline } from './retention'

type Prepared = Awaited<ReturnType<typeof prepareAuthoritativeEBalanceExport>>

/** Publish the same report evidence for both XML preparation and ZIP export. */
export async function retainEBalanceReport(transaction: Prisma.TransactionClient, input: {
  ownerId: string; actorId: string; id: string; prepared: Prepared
  storageKey: string; storageChecksum: string; status: 'PREPARED' | 'EXPORTED'; reason: string
}) {
  const { ownerId, actorId, prepared, storageKey } = input
  const { dataset, xml, reportChecksum, diagnostics } = prepared
  await assertCurrentEBalanceExport(transaction, ownerId, prepared)
  const fiscalYearId = dataset.fiscalYear.id
  const existing = await transaction.eBalanceLifecycleReport.findFirst({ where: { ownerId, fiscalYearId, closeGenerationId: dataset.closeGenerationId, reportChecksum } })
  if (existing) return { report: existing, created: false }
  const latest = await transaction.eBalanceLifecycleReport.findFirst({ where: { ownerId, fiscalYearId }, orderBy: { version: 'desc' } })
  const createdAt = new Date()
  const report = await transaction.eBalanceLifecycleReport.create({ data: {
    id: input.id, ownerId, fiscalYearId, closeGenerationId: dataset.closeGenerationId, version: (latest?.version ?? 0) + 1,
    status: input.status, taxonomyVersion: dataset.taxonomy.version, profileSnapshot: canonicalJson(dataset.company),
    reportPayload: serializePreparedEBalanceEvidence(prepared), reportXml: xml, reportChecksum, storageKey,
    validationDiagnostics: canonicalJson(diagnostics), validationEngine: diagnostics.engine, validatedAt: createdAt,
    supersedesId: latest?.id ?? null, createdBy: actorId, createdAt,
  } })
  // A report created after its fiscal year must not expire before the end of
  // the retention window measured from the year in which it was created.
  const retentionStart = [dataset.fiscalYear.endsAt, createdAt.toISOString().slice(0, 10)].sort().at(-1)!
  const deadline = retentionDeadline('TAX_RECORD', retentionStart)
  await transaction.retainedArtifact.create({ data: {
    ownerId, objectType: 'EBalanceLifecycleReport', objectId: report.id, version: report.version,
    retentionClass: 'TAX_RECORD', contentHash: input.storageChecksum, provenance: `taxonomy:${dataset.taxonomy.version};validation:LOCAL_STRUCTURAL`,
    storageKey, periodEndsAt: new Date(`${dataset.fiscalYear.endsAt}T23:59:59.999Z`), retainUntil: new Date(`${deadline.retainUntil}T23:59:59.999Z`),
  } })
  for (const action of ['E_BILANZ_REPORT_PREPARED', 'E_BILANZ_REPORT_LOCALLY_VALIDATED']) {
    await appendAuditEvent(transaction, { ownerId, actorId, action, reason: input.reason, objectType: 'EBalanceLifecycleReport', objectId: report.id,
      after: { version: report.version, closeGenerationId: dataset.closeGenerationId, reportChecksum, validationLevel: diagnostics.level, officialAcceptance: diagnostics.officialAcceptance } })
  }
  if (latest) await appendAuditEvent(transaction, { ownerId, actorId, action: 'E_BILANZ_REPORT_SUPERSEDED', reason: input.reason,
    objectType: 'EBalanceLifecycleReport', objectId: latest.id,
    after: { successorId: report.id, successorVersion: report.version, successorChecksum: reportChecksum } })
  return { report, created: true }
}
