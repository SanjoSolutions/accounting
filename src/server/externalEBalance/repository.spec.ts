import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Prisma } from '@/generated/prisma/client'
import { createExternalPackage, hashBytes, type ExternalEBalanceSource } from './adapter'
vi.mock('server-only', () => ({}))
import { createExternalEBalanceRepository, validateExternalEvidence, type ExternalEvidenceInput } from './repository'

const source: ExternalEBalanceSource = { fiscalYearId: 'fy-2026', year: 2026, startsAt: '2026-01-01', endsAt: '2026-12-31', closeGenerationId: 'close-1', sourceFingerprint: 'a'.repeat(64), taxonomyVersion: '6.9', accounts: [
  { accountId: 'bank', number: 1200, name: 'Bank', category: 'ASSET', eBilanzPosition: 'bs.ass.currAss.cashEquiv.bank', debitCents: 10000, creditCents: 0, balanceCents: 10000 },
  { accountId: 'capital', number: 800, name: 'Kapital', category: 'EQUITY', eBilanzPosition: 'bs.eqLiab.equity.subscribed', debitCents: 0, creditCents: 10000, balanceCents: -10000 },
], dataset: { reconciliation: 'reviewed' }, xbrl: '<xbrl/>', xbrlPackage: new Uint8Array([80, 75]) }
const bytes = Buffer.from(createExternalPackage(source, 1).archive)
const artifact = { id: 'package-1', ownerId: 'tenant-a', objectType: 'ExternalEBalancePackage', objectId: 'fy-2026', version: 1, contentHash: hashBytes(bytes), storageKey: 'stored.zip', periodEndsAt: new Date('2026-12-31Z'), retainUntil: new Date('2036-12-31Z'), createdAt: new Date('2027-01-01Z') }
const input: ExternalEvidenceInput = { packageHash: artifact.contentHash, kind: 'ACCEPTANCE_CLAIM', provider: 'myebilanz', occurredAt: '2026-10-01T10:00:00Z', note: 'Benutzerprotokoll; Zielprogramm hat die Daten ergänzt.', confirmSource: true, fileName: 'beleg.pdf', bytes: new Uint8Array([1, 2, 3]) }
const findPeriod = vi.fn(); const findArtifact = vi.fn(); const findMany = vi.fn(); const create = vi.fn(); const audit = vi.fn(); const prepare = vi.fn()
const storage = { read: vi.fn(), write: vi.fn(), delete: vi.fn() }
const database = { fiscalYear: { findFirst: findPeriod }, retainedArtifact: { findFirst: findArtifact, findMany, create }, $transaction: vi.fn() }
const repository = createExternalEBalanceRepository({ database: database as unknown as Parameters<typeof createExternalEBalanceRepository>[0]['database'], storage: () => storage as unknown as ReturnType<Parameters<typeof createExternalEBalanceRepository>[0]['storage']>, prepare, audit })

beforeEach(() => {
  vi.clearAllMocks()
  findPeriod.mockResolvedValue({ id: source.fiscalYearId, year: 2026, endsAt: artifact.periodEndsAt })
  findArtifact.mockResolvedValue(artifact); findMany.mockResolvedValue([])
  create.mockImplementation(async ({ data }) => data)
  storage.read.mockResolvedValue(bytes); storage.write.mockResolvedValue(undefined); storage.delete.mockResolvedValue(undefined)
  prepare.mockResolvedValue(source)
  database.$transaction.mockImplementation(async (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => work(database as unknown as Prisma.TransactionClient))
})
describe('Retained external E-Bilanz packages and manual evidence', () => {
  test('Given a current closed dataset with no ERiC environment, when preparing, then exact bytes are retained as the next version with the real actor', async () => {
    const result = await repository.create('tenant-a', 'accountant-b', 2026)
    expect(result.version).toBe(2)
    expect(prepare).toHaveBeenLastCalledWith('tenant-a', 'fy-2026', database)
    const stored = storage.write.mock.calls[0][1] as Buffer
    expect(result.contentHash).toBe(hashBytes(stored))
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ ownerId: 'tenant-a', objectType: 'ExternalEBalancePackage', version: 2, contentHash: result.contentHash }) })
    expect(audit).toHaveBeenCalledWith(database, expect.objectContaining({ actorId: 'accountant-b', action: 'EXTERNAL_E_BILANZ_PREPARED' }))
  })
  test('Given missing close evidence or a reconciliation change during preparation, when creating, then no package is written', async () => {
    prepare.mockRejectedValueOnce(new Error('stale close'))
    await expect(repository.create('tenant-a', 'actor', 2026)).rejects.toThrow('stale close')
    prepare.mockResolvedValueOnce(source).mockResolvedValueOnce({ ...source, sourceFingerprint: 'b'.repeat(64) })
    await expect(repository.create('tenant-a', 'actor', 2026)).rejects.toThrow(/geändert/)
    expect(storage.write).not.toHaveBeenCalled()
  })
  test('Given registration fails after staging, when creating, then only the new staged object is removed', async () => {
    create.mockRejectedValueOnce(new Error('conflict'))
    await expect(repository.create('tenant-a', 'actor', 2026)).rejects.toThrow('conflict')
    expect(storage.delete).toHaveBeenCalledWith(storage.write.mock.calls[0][0])
    expect(storage.delete).not.toHaveBeenCalledWith('stored.zip')
  })
  test('Given an older retained version, when downloading after source changes, then original bytes remain downloadable with stale status and an audit record', async () => {
    prepare.mockRejectedValue(new Error('closed source changed'))
    const result = await repository.download('tenant-a', 'reader', 2026, 'package-1')
    expect(result.content).toEqual(bytes); expect(result.sourceStatus).toBe('STALE')
    expect(storage.write).not.toHaveBeenCalled()
    expect(audit).toHaveBeenCalledWith(database, expect.objectContaining({ actorId: 'reader', after: expect.objectContaining({ sourceStatus: 'STALE', packageHash: artifact.contentHash }) }))
  })
  test('Given a different tenant, invalid file, or tampered retained bytes, when downloading, then content is not returned', async () => {
    findArtifact.mockResolvedValueOnce(null)
    await expect(repository.download('tenant-b', 'actor', 2026, 'package-1')).rejects.toThrow(/nicht gefunden/)
    expect(findArtifact).toHaveBeenCalledWith({ where: expect.objectContaining({ ownerId: 'tenant-b', objectId: 'fy-2026', objectType: 'ExternalEBalancePackage' }) })
    await expect(repository.download('tenant-a', 'actor', 2026, 'package-1', '../secret')).rejects.toThrow(/nicht gefunden/)
    storage.read.mockResolvedValueOnce(Buffer.from('changed'))
    await expect(repository.download('tenant-a', 'actor', 2026, 'package-1')).rejects.toThrow(/verändert/)
    expect(audit).not.toHaveBeenCalled()
  })
  test('Given an uploaded acceptance claim, when explicitly attached, then it remains unauthenticated evidence against exact package bytes', async () => {
    const result = await repository.attachEvidence('tenant-a', 'actor-b', 2026, 'package-1', input)
    expect(result).toMatchObject({ trust: 'USER_SUPPLIED_UNAUTHENTICATED', kind: 'ACCEPTANCE_CLAIM', packageHash: artifact.contentHash, packageVersion: 1, recordedBy: 'actor-b' })
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ objectType: 'ExternalEBalanceEvidence', objectId: 'package-1' }) })
    expect(audit).toHaveBeenCalledWith(database, expect.objectContaining({ action: 'EXTERNAL_E_BILANZ_EVIDENCE_ATTACHED' }))
  })
  test('Given another package hash or no explicit confirmation, when attaching evidence, then no evidence is stored', async () => {
    await expect(repository.attachEvidence('tenant-a', 'actor', 2026, 'package-1', { ...input, packageHash: 'b'.repeat(64) })).rejects.toThrow(/Exportbytes/)
    await expect(repository.attachEvidence('tenant-a', 'actor', 2026, 'package-1', { ...input, confirmSource: false })).rejects.toThrow(/bestätigt/)
    expect(storage.write).not.toHaveBeenCalled()
  })
  test.each([{ ...input, bytes: new Uint8Array() }, { ...input, kind: 'ACCEPTED' }, { ...input, occurredAt: '2026-02-30T10:00:00Z' }, { ...input, bytes: new Uint8Array(5 * 1024 * 1024 + 1) }])('Given malformed or oversized manual evidence, when parsed, then it fails before persistence', value => {
    expect(() => validateExternalEvidence(value)).toThrow()
  })
})
