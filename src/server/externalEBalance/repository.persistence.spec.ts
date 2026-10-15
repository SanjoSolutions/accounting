import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { strFromU8, unzipSync } from 'fflate'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { PrismaClient } from '@/generated/prisma/client'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { createExternalEBalanceRepository } from './repository'
import type { DocumentStorage } from '@/server/storage/DocumentStorage'
import type { ExternalEBalanceSource } from './adapter'

const directory = mkdtempSync(join(tmpdir(), 'accounting-external-export-test-'))
const databasePath = join(directory, 'disposable.db')
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${databasePath.replaceAll('\\', '/')}` }) })
const source: ExternalEBalanceSource = { fiscalYearId: 'fy', year: 2026, startsAt: '2026-01-01', endsAt: '2026-12-31', closeGenerationId: 'close', sourceFingerprint: 'a'.repeat(64), taxonomyVersion: '6.9', accounts: [
  { accountId: 'bank', number: 1200, name: 'Bank', category: 'ASSET', eBilanzPosition: 'bs.ass.currAss.cashEquiv.bank', debitCents: 12000, creditCents: 0, balanceCents: 12000 },
  { accountId: 'capital', number: 800, name: 'Kapital', category: 'EQUITY', eBilanzPosition: 'bs.eqLiab.equity.subscribed', debitCents: 0, creditCents: 12000, balanceCents: -12000 },
], dataset: { synthetic: true }, xbrl: '<synthetic-fixture/>', xbrlPackage: new Uint8Array([80, 75]) }
let stale = false
const storage: Pick<DocumentStorage, 'read' | 'write' | 'delete'> = {
  async write(key: string, content: Buffer) { const file = join(directory, key); await mkdir(resolve(file, '..'), { recursive: true }); await writeFile(file, content) },
  async read(key: string) { return readFile(join(directory, key)) },
  async delete(key: string) { await unlink(join(directory, key)) },
}
const repository = createExternalEBalanceRepository({ database: prisma, storage: () => storage, prepare: async () => { if (stale) throw new Error('Source changed'); return source }, assertCurrent: async () => { if (stale) throw new Error('Source changed') } })

beforeAll(async () => {
  const database = new DatabaseSync(databasePath)
  const migrations = resolve('prisma/migrations')
  for (const name of readdirSync(migrations, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()) database.exec(readFileSync(join(migrations, name, 'migration.sql'), 'utf8'))
  database.close()
  await prisma.fiscalYear.create({ data: { id: 'fy', ownerId: 'tenant', year: 2026, startsAt: new Date('2026-01-01'), endsAt: new Date('2026-12-31') } })
  await prisma.fiscalYear.create({ data: { id: 'other-fy', ownerId: 'other-tenant', year: 2026, startsAt: new Date('2026-01-01'), endsAt: new Date('2026-12-31') } })
}, 120_000)
afterAll(async () => {
  await prisma.$disconnect()
  if (resolve(directory, '..') !== resolve(tmpdir()) || !directory.includes('accounting-external-export-test-')) throw new Error('Unexpected disposable test directory')
  rmSync(directory, { recursive: true, force: true })
})

describe('Durable external package retention', () => {
  test('Given separate preparation, download and evidence transactions, when reopened, then versions, exact bytes and trust remain bound without altering gateway submissions', async () => {
    const first = await repository.create('tenant', 'preparer', 2026)
    const second = await repository.create('tenant', 'preparer', 2026)
    expect([first.version, second.version]).toEqual([1, 2])
    const original = await repository.download('tenant', 'reader', 2026, first.id)
    const evidence = await repository.attachEvidence('tenant', 'recorder', 2026, first.id, { packageHash: first.contentHash, kind: 'TRANSMISSION', provider: 'myebilanz', occurredAt: '2026-10-01T00:00:00Z', note: 'Synthetic manual evidence', confirmSource: true, fileName: 'receipt.txt', bytes: Buffer.from('synthetic') })
    const retainedEvidence = await repository.downloadEvidence('tenant', 'reader', 2026, first.id, evidence.id)
    expect(strFromU8(unzipSync(retainedEvidence.content)['receipt.bin'])).toBe('synthetic')
    await expect(repository.downloadEvidence('tenant', 'reader', 2026, second.id, evidence.id)).rejects.toThrow(/nicht gefunden/)
    stale = true
    expect((await repository.download('tenant', 'reader', 2026, first.id)).content).toEqual(original.content)
    await expect(repository.create('tenant', 'preparer', 2026)).rejects.toThrow('Source changed')
    await expect(repository.download('other-tenant', 'reader', 2026, first.id)).rejects.toThrow(/nicht gefunden/)
    const reopened = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${databasePath.replaceAll('\\', '/')}` }) })
    try {
      const rows = await reopened.retainedArtifact.findMany({ where: { ownerId: 'tenant', objectType: 'ExternalEBalancePackage' }, orderBy: { version: 'asc' } })
      expect(rows.map(row => row.contentHash)).toEqual([first.contentHash, second.contentHash])
      const receipt = await reopened.retainedArtifact.findUniqueOrThrow({ where: { id: evidence.id } })
      expect(JSON.parse(receipt.provenance)).toMatchObject({ packageId: first.id, packageHash: first.contentHash, trust: 'USER_SUPPLIED_UNAUTHENTICATED', recordedBy: 'recorder' })
      expect(await reopened.eBalanceSubmission.count()).toBe(0)
      const events = await reopened.auditEvent.findMany({ where: { ownerId: 'tenant' } })
      expect(events.map(event => event.actorId)).toContain('recorder')
      await storage.write(rows[0].storageKey!, Buffer.from('tampered'), { contentType: 'application/zip', fileName: 'test.zip' })
      await expect(repository.download('tenant', 'reader', 2026, first.id)).rejects.toThrow(/verändert/)
    } finally { await reopened.$disconnect() }
  }, 60_000)
})
