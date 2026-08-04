import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PrismaClient } from '@/generated/prisma/client'

vi.mock('server-only', () => ({}))
const generation = { id: 'generation-current' }
vi.mock('@/server/fiscalCloseGeneration', () => ({ requireCurrentFiscalCloseGeneration: vi.fn(async () => generation) }))

const directory = mkdtempSync(join(tmpdir(), 'accounting-e-bilanz-lifecycle-'))
const databasePath = join(directory, 'test.db').replace(/\\/g, '/')
let api: typeof import('./eBilanzRepository')
let prisma: typeof import('@/server/persistence/client').prisma

beforeAll(async () => {
  const database = new DatabaseSync(databasePath)
  const migrations = resolve(process.cwd(), 'prisma', 'migrations')
  for (const name of readdirSync(migrations, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort()) database.exec(readFileSync(join(migrations, name, 'migration.sql'), 'utf8'))
  database.close()
  process.env.DATABASE_URL = `file:${databasePath}`
  api = await import('./eBilanzRepository')
  prisma = (await import('@/server/persistence/client')).prisma
  const lockedAt = new Date('2027-01-02T10:00:00.000Z')
  await prisma.fiscalYear.create({ data: { id: 'fy-2026', ownerId: 'tenant-a', year: 2026, startsAt: new Date('2026-01-01'), endsAt: new Date('2026-12-31T23:59:59.999Z'), status: 'CLOSED', lockedAt, closingSnapshot: '{"locked":true}' } })
  await prisma.hgbCloseRun.create({ data: { id: 'hgb-current', ownerId: 'tenant-a', fiscalPeriodId: 'fy-2026', version: 1, status: 'READY_TO_LOCK', ruleSetVersion: 'HGB-2026', ledgerFingerprint: 'ledger', inputChecksum: 'input', checksum: 'hgb-checksum', payload: '{}', createdBy: 'reviewer' } })
  await prisma.fiscalCloseGeneration.create({ data: { ...generation, ownerId: 'tenant-a', fiscalYearId: 'fy-2026', generation: 1, hgbCloseRunId: 'hgb-current', hgbCloseRunChecksum: 'hgb-checksum', snapshotHash: 'snapshot', lockedAt } })
})

afterAll(async () => {
  await prisma.$disconnect()
  delete process.env.DATABASE_URL
  rmSync(directory, { recursive: true, force: true })
})

describe('persistent E-Bilanz stale-version remediation evidence', () => {
  it('Given two retained reports for one exact close generation, when the overview is reloaded, then only the newest version is current and the superseded version remains stale', async () => {
    const report = (id: string, version: number, checksum: string, createdAt: Date, supersedesId: string | null) => ({ id, ownerId: 'tenant-a', fiscalYearId: 'fy-2026', closeGenerationId: generation.id, version, status: 'EXPORTED', taxonomyVersion: '6.9', profileSnapshot: JSON.stringify({ city: version === 1 ? 'Berlin' : 'Berlin-Mitte' }), reportPayload: '{}', reportXml: `<report version="${version}"/>`, reportChecksum: checksum, storageKey: `tax-exports/${id}.zip`, supersedesId, createdBy: 'user-a', createdAt })
    await prisma.eBalanceLifecycleReport.create({ data: report('report-v1', 1, 'checksum-v1', new Date('2027-01-02T11:00:00Z'), null) })
    await prisma.eBalanceLifecycleReport.create({ data: report('report-v2', 2, 'checksum-v2', new Date('2027-01-02T12:00:00Z'), 'report-v1') })

    await expect(api.getEBalanceLifecycleOverview('tenant-a', 'fy-2026')).resolves.toMatchObject({
      closeEvidence: { currentCloseGenerationId: generation.id, sourceStatus: 'CURRENT' },
      reports: [
        { id: 'report-v2', version: 2, closeGenerationId: generation.id, sourceStatus: 'CURRENT', supersedesId: 'report-v1' },
        { id: 'report-v1', version: 1, closeGenerationId: generation.id, sourceStatus: 'STALE' },
      ],
    })
    const reopened = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${databasePath}` }) })
    await expect(reopened.eBalanceLifecycleReport.findMany({ where: { ownerId: 'tenant-a' }, orderBy: { version: 'asc' }, select: { id: true, version: true, closeGenerationId: true, supersedesId: true } })).resolves.toEqual([
      { id: 'report-v1', version: 1, closeGenerationId: generation.id, supersedesId: null },
      { id: 'report-v2', version: 2, closeGenerationId: generation.id, supersedesId: 'report-v1' },
    ])
    await reopened.$disconnect()
  })
})
