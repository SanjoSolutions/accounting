import { beforeEach, describe, expect, it, vi } from 'vitest'

const objects = vi.hoisted(() => new Map<string, Buffer>())
const storageState = vi.hoisted(() => ({ failDelete: false }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/storage', () => ({ getDocumentStorage: () => ({
  write: vi.fn(async (key: string, content: Buffer) => { objects.set(key, Buffer.from(content)) }),
  read: vi.fn(async (key: string) => Buffer.from(objects.get(key)!)),
  delete: vi.fn(async (key: string) => { if (storageState.failDelete) throw new Error('delete failed'); objects.delete(key) }),
  exists: vi.fn(async (key: string) => objects.has(key)),
}) }))
import { excludeBackupPayloadLocators, exerciseIsolatedObjectRestore, snapshotStorageReferences, verifyRestoredArtifactObjects, verifyRestoredStorageObjects, verifySnapshotInIsolatedDatabase } from './restoreVerification'

const snapshot = () => ({
  schemaVersion: 1, ownerId: 'tenant', settings: [], profiles: [], profileAddressConfirmations: [], periods: [], ledgerProfile: null,
  accounts: [], mappings: [], entries: [], documents: [], storageClaims: [], artifacts: [], fixityChecks: [],
  audit: [], auditHead: null, drafts: [], reopenRequests: [], amendments: [], eBalanceSubmissions: [], backupManifests: [], policy: null,
})

describe('isolated restore verification', () => {
  beforeEach(() => { objects.clear(); storageState.failDelete = false })
  it('loads the canonical snapshot through the real migration chain and rejects rows that do not satisfy the deployed schema', () => {
    expect(verifySnapshotInIsolatedDatabase(snapshot())).toEqual({ periods: 0, entries: 0, documents: 0, eBalanceSubmissions: 0 })
    expect(() => verifySnapshotInIsolatedDatabase({ ...snapshot(), settings: [{ id: 's', ownerId: 'tenant' }] })).toThrow(/NOT NULL/)
  })
  it('binds every restored byte stream to retained-artifact fixity metadata', () => {
    const content = Buffer.from('exact')
    expect(verifyRestoredArtifactObjects([{ storageKey: 'document', contentHash: 'fa79d4746c21cd960a17b92db8976ddef95a7e20b590721f8e0fa7847a05e486' }], { document: content })).toEqual({ objectCount: 1 })
    expect(() => verifyRestoredArtifactObjects([{ storageKey: 'document', contentHash: '0'.repeat(64) }], { document: content })).toThrow(/fixity/)
  })
  it('requires every live document, thumbnail and storage claim without recursively embedding prior backups', () => {
    const value = { ...snapshot(),
      documents: [{ id: 'document', ownerId: 'tenant', payload: JSON.stringify({ storageKey: 'document.pdf', thumbnailStorageKey: 'document.webp' }) }],
      storageClaims: [{ id: 'claim', ownerId: 'tenant', storageKey: 'claimed.pdf' }],
      backupManifests: [{ id: 'prior', ownerId: 'tenant', payloadStorageKey: 'prior-backup.json' }],
    }
    const references = snapshotStorageReferences(value)
    expect(references).toEqual(['claimed.pdf', 'document.pdf', 'document.webp'])
    expect(() => verifyRestoredStorageObjects([], { 'document.pdf': Buffer.from('only one') }, references)).toThrow(/live storage references/)
  })
  it('marks historical manifests as unavailable when their encrypted payloads are excluded', () => {
    expect(excludeBackupPayloadLocators([{ id: 'prior', payloadStorageKey: 'prior.json', status: 'RESTORE_VERIFIED' }])).toEqual([
      { id: 'prior', payloadStorageKey: null, status: 'PAYLOAD_EXCLUDED' },
    ])
  })
  it('excludes document references after their last retained version is disposed', () => {
    const value = { ...snapshot(),
      documents: [{ id: 'document', ownerId: 'tenant', payload: JSON.stringify({ storageKey: 'deleted.pdf', thumbnailStorageKey: 'deleted.webp' }) }],
      artifacts: [{ id: 'artifact', ownerId: 'tenant', objectType: 'Document', objectId: 'document', storageKey: 'deleted.pdf', storageDeletedAt: '2026-01-01', disposedAt: '2026-01-01', contentHash: '0'.repeat(64) }],
    }
    expect(snapshotStorageReferences(value)).toEqual([])
  })
  it('writes, rereads, verifies and removes restored objects in an isolated namespace', async () => {
    await expect(exerciseIsolatedObjectRestore('tenant', 'backup', { 'documents/a.pdf': Buffer.from('exact') })).resolves.toEqual({ objectCount: 1 })
    expect(objects.size).toBe(0)
  })
  it('blocks certification when decrypted object cleanup fails', async () => {
    storageState.failDelete = true
    await expect(exerciseIsolatedObjectRestore('tenant', 'backup', { document: Buffer.from('sensitive') })).rejects.toThrow(/cleanup failed/)
    expect(objects.size).toBe(1)
  })
})
