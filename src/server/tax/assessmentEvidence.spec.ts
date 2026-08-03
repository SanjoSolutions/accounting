import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ document: vi.fn(), artifact: vi.fn(), read: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/persistence/client', () => ({ prisma: {
  documentRecord: { findFirst: mocks.document }, retainedArtifact: { findFirst: mocks.artifact },
} }))
vi.mock('@/server/storage', () => ({ getDocumentStorage: () => ({ read: mocks.read }) }))

import { createHash } from 'node:crypto'
import { assessmentNoticePayloadHash, createOrReplayAssessment, resolveCanonicalAssessmentEvidence } from './assessmentEvidence'

const content = Buffer.from('authoritative Finanzamt notice')
const contentHash = createHash('sha256').update(content).digest('hex')
const notice = {
  authority: 'FINANZAMT' as const, noticeId: 'KSt-2025-1', kind: 'KST', period: '2025', assessedAmountCents: 1582,
  receivedAt: new Date('2026-08-01T00:00:00.000Z'), documentId: 'document-1', documentHash: contentHash,
  evidenceStorageKey: 'documents/tenant-a/document-1.pdf', declarationSubmissionId: 'submission-1',
  comparisonBasis: 'NON_BINDING_PREVIEW' as const, previewRuleVersion: 'DE-UG-SIMPLE-2025.1', annualCaseId: 'case-1', differenceCents: 0, needsReview: false,
}

describe('authoritative assessment evidence and notice identity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.document.mockResolvedValue({ id: 'document-1', payload: JSON.stringify({ storageKey: 'documents/tenant-a/document-1.pdf' }) })
    mocks.artifact.mockResolvedValue({ contentHash, storageKey: 'documents/tenant-a/document-1.pdf' })
    mocks.read.mockResolvedValue(content)
  })

  it('derives the hash from the tenant canonical retained storage object', async () => {
    await expect(resolveCanonicalAssessmentEvidence('tenant-a', 'document-1', contentHash)).resolves.toEqual({ documentId: 'document-1', documentHash: contentHash, storageKey: 'documents/tenant-a/document-1.pdf' })
    expect(mocks.artifact).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ ownerId: 'tenant-a', objectType: 'Document', objectId: 'document-1', storageKey: 'documents/tenant-a/document-1.pdf', disposedAt: null, storageDeletedAt: null }) }))
  })

  it('rejects caller hash substitution and retained-storage tampering', async () => {
    await expect(resolveCanonicalAssessmentEvidence('tenant-a', 'document-1', '0'.repeat(64))).rejects.toThrow(/does not match/)
    mocks.artifact.mockResolvedValue({ contentHash: '0'.repeat(64), storageKey: 'documents/tenant-a/document-1.pdf' })
    await expect(resolveCanonicalAssessmentEvidence('tenant-a', 'document-1')).rejects.toThrow(/fixity/)
  })

  it('replays the same tenant notice payload and rejects conflicting reuse', async () => {
    const existing = { id: 'assessment-1', noticePayloadHash: assessmentNoticePayloadHash(notice) }
    const findUnique = vi.fn().mockResolvedValue(existing); const create = vi.fn(); const onCreated = vi.fn()
    const transaction = { taxAssessmentRecord: { findUnique, create } } as never
    await expect(createOrReplayAssessment(transaction, 'tenant-a', 'new-client-id', notice, onCreated)).resolves.toBe(existing)
    expect(create).not.toHaveBeenCalled(); expect(onCreated).not.toHaveBeenCalled()
    findUnique.mockResolvedValue({ ...existing, noticePayloadHash: 'different' })
    await expect(createOrReplayAssessment(transaction, 'tenant-a', 'other-id', { ...notice, assessedAmountCents: 2000 }, onCreated)).rejects.toThrow(/already bound to different/)
  })
})
