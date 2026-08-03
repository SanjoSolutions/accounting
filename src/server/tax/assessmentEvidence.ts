import 'server-only'

import { createHash } from 'node:crypto'
import type { Prisma } from '@/generated/prisma/client'
import { canonicalJson } from '@/core/compliance/auditExport'
import { TaxDeclarationError } from '@/core/taxDeclarations'
import { prisma } from '@/server/persistence/client'
import { getDocumentStorage } from '@/server/storage'

export async function resolveCanonicalAssessmentEvidence(ownerId: string, documentId: string, claimedHash?: string) {
  const document = await prisma.documentRecord.findFirst({ where: { id: documentId, ownerId }, select: { id: true, payload: true } })
  if (!document) throw new TaxDeclarationError(['The Finanzamt assessment evidence document must belong to this tenant.'])
  let storageKey: string
  try {
    const payload = JSON.parse(document.payload) as { storageKey?: unknown }
    if (typeof payload.storageKey !== 'string' || !payload.storageKey) throw new Error('missing storage key')
    storageKey = payload.storageKey
  } catch { throw new TaxDeclarationError(['The Finanzamt assessment evidence document has no canonical readable storage identity.']) }
  const artifact = await prisma.retainedArtifact.findFirst({
    where: { ownerId, objectType: 'Document', objectId: document.id, storageKey, disposedAt: null, storageDeletedAt: null },
    orderBy: { version: 'desc' }, select: { contentHash: true, storageKey: true },
  })
  if (!artifact?.storageKey) throw new TaxDeclarationError(['The Finanzamt assessment evidence document has no canonical retained artifact.'])
  let content: Buffer
  try { content = await getDocumentStorage().read(artifact.storageKey) }
  catch { throw new TaxDeclarationError(['The Finanzamt assessment evidence storage object is not readable.']) }
  const documentHash = createHash('sha256').update(content).digest('hex')
  if (documentHash !== artifact.contentHash) throw new TaxDeclarationError(['The Finanzamt assessment evidence failed canonical storage fixity verification.'])
  if (claimedHash !== undefined && claimedHash.toLowerCase() !== documentHash) throw new TaxDeclarationError(['The supplied Finanzamt evidence hash does not match the canonical stored document.'])
  return { documentId: document.id, documentHash, storageKey: artifact.storageKey }
}

type AssessmentNoticeIdentity = {
  authority: 'FINANZAMT'
  noticeId: string
  kind: string
  period: string
  assessedAmountCents: number
  receivedAt: Date
  documentId: string
  documentHash: string
  evidenceStorageKey: string
  declarationSubmissionId: string
  comparisonBasis: 'DECLARED_LIABILITY' | 'NON_BINDING_PREVIEW'
  previewRuleVersion: string | null
  annualCaseId: string | null
  differenceCents: number
  needsReview: boolean
}

export function assessmentNoticePayloadHash(value: AssessmentNoticeIdentity) {
  return createHash('sha256').update(canonicalJson({ ...value, receivedAt: value.receivedAt.toISOString() })).digest('hex')
}

export async function createOrReplayAssessment(
  transaction: Prisma.TransactionClient,
  ownerId: string,
  id: string,
  value: AssessmentNoticeIdentity,
  onCreated: (record: { id: string }) => Promise<void>,
) {
  const noticeId = value.noticeId.trim()
  const noticePayloadHash = assessmentNoticePayloadHash({ ...value, noticeId })
  const existing = await transaction.taxAssessmentRecord.findUnique({ where: { ownerId_noticeId: { ownerId, noticeId } } })
  if (existing) {
    if (existing.noticePayloadHash !== noticePayloadHash) throw new TaxDeclarationError(['This Finanzamt notice identity is already bound to different authoritative assessment data.'])
    return existing
  }
  const record = await transaction.taxAssessmentRecord.create({ data: {
    id, ownerId, ...value, noticeId, noticePayloadHash,
  } })
  await onCreated(record)
  return record
}
