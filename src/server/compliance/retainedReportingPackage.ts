import 'server-only'

import type { CompliancePackage, Prisma } from '@/generated/prisma/client'
import { canonicalJson } from '@/core/compliance/auditExport'
import { getDocumentStorage } from '@/server/storage'
import { sha256 } from './retention'
import { ComplianceRuntimeError } from './errors'

export function reportingPackageChecksum(record: Pick<CompliancePackage, 'kind' | 'fiscalPeriodId' | 'authorityRef' | 'payload'>) {
  return sha256(canonicalJson({ kind: record.kind, fiscalPeriodId: record.fiscalPeriodId, authorityRef: record.authorityRef, payload: JSON.parse(record.payload) }))
}

/** Bind the selected DB version, retention registration and exact object bytes. */
export async function readRetainedReportingPackage(client: Prisma.TransactionClient, record: CompliancePackage) {
  let valid = false
  try { valid = reportingPackageChecksum(record) === record.checksum } catch { /* fail closed */ }
  if (!valid) throw new ComplianceRuntimeError('The retained package metadata failed its checksum check', 409)
  const artifact = await client.retainedArtifact.findFirst({ where: {
    ownerId: record.ownerId, objectType: 'CompliancePackage', objectId: record.id, version: record.version,
    disposedAt: null, storageDeletedAt: null,
  } })
  if (!record.storageKey || !artifact || artifact.storageKey !== record.storageKey) throw new ComplianceRuntimeError('The retained package registration is unavailable or does not match its storage object', 409)
  let content: Buffer
  try { content = await getDocumentStorage().read(record.storageKey) }
  catch { throw new ComplianceRuntimeError('The retained package bytes are unavailable', 409) }
  if (sha256(content) !== artifact.contentHash || !content.equals(Buffer.from(record.payload, 'utf8'))) throw new ComplianceRuntimeError('The retained package failed its exact-byte fixity check', 409)
  return { content, artifact }
}
