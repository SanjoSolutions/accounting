import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Prisma } from '@/generated/prisma/client'
import { sha256 } from './retention'

const mocks = vi.hoisted(() => ({ read: vi.fn(), artifacts: vi.fn(), documents: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/storage', () => ({ getDocumentStorage: () => ({ read: mocks.read }) }))
import { closeEvidenceIds, loadVerifiedCloseEvidence } from './closeEvidence'

const client = { retainedArtifact: { findMany: mocks.artifacts }, documentRecord: { findMany: mocks.documents } } as unknown as Prisma.TransactionClient
const artifact = { id: 'retention-1', objectId: 'doc-1', objectType: 'Document', storageKey: 'documents/tenant-a/doc-1', contentHash: sha256('original bytes') }

describe('close evidence byte boundary', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.read.mockResolvedValue(Buffer.from('original bytes'))
    mocks.artifacts.mockResolvedValue([artifact])
    mocks.documents.mockResolvedValue([{ id: 'doc-1', payload: JSON.stringify({ storageKey: artifact.storageKey }) }])
  })

  test('Given document and retained-artifact references, when checked, then both resolve through tenant-scoped metadata to verified bytes', async () => {
    const result = await loadVerifiedCloseEvidence(client, 'tenant-a', ['doc-1', 'retention-1'])
    expect(result.missingEvidenceIds).toEqual([])
    expect(result.evidence.map(item => item.id)).toEqual(['doc-1', 'retention-1'])
    expect(mocks.artifacts).toHaveBeenCalledWith({ where: expect.objectContaining({ ownerId: 'tenant-a', disposedAt: null, storageDeletedAt: null }) })
    expect(mocks.documents).toHaveBeenCalledWith({ where: { ownerId: 'tenant-a', id: { in: ['doc-1', 'retention-1'] } }, select: { id: true, payload: true } })
  })

  test.each(['changed', 'missing', 'unretained', 'foreign-reference', 'padded-reference', 'conflicting-hashes'])('Given %s evidence, when the close resolves it, then the evidence remains unresolved', async scenario => {
    let id = 'doc-1'
    if (scenario === 'changed') mocks.read.mockResolvedValue(Buffer.from('changed bytes'))
    if (scenario === 'missing') mocks.read.mockRejectedValue(new Error('missing'))
    if (scenario === 'unretained') mocks.artifacts.mockResolvedValue([])
    if (scenario === 'foreign-reference') id = 'tenant-b-doc'
    if (scenario === 'padded-reference') id = ' doc-1 '
    if (scenario === 'conflicting-hashes') mocks.artifacts.mockResolvedValue([artifact, { ...artifact, id: 'retention-2', contentHash: sha256('other') }])
    expect((await loadVerifiedCloseEvidence(client, 'tenant-a', [id])).missingEvidenceIds).toEqual([id])
  })

  test('Given nested workpaper evidence, when reference IDs are collected, then schedule evidence and signatures are included once', () => {
    expect(closeEvidenceIds({ evidenceIds: ['a'], schedule: { rows: [{ supportingEvidenceIds: ['b', 'a'], signatureEvidenceId: 'c' }] } })).toEqual(['a', 'b', 'c'])
  })
})
