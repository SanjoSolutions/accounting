import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { parseDatevFiles } from '@/core/datev'

vi.mock('server-only', () => ({}))
const directory = mkdtempSync(join(tmpdir(), 'accounting-datev-export-'))
const databasePath = join(directory, 'test.db').replace(/\\/g, '/')
let api: typeof import('./datevExport')
let prisma: typeof import('./persistence/client').prisma

beforeAll(async () => {
  const database = new DatabaseSync(databasePath)
  for (const name of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort()) database.exec(readFileSync(resolve('prisma/migrations', name, 'migration.sql'), 'utf8'))
  database.close()
  process.env.DATABASE_URL = `file:${databasePath}`; process.env.DOCUMENT_STORAGE_DRIVER = 'fs'; process.env.DOCUMENT_STORAGE_ROOT = join(directory, 'storage'); process.env.AUDIT_INTEGRITY_SECRET = 'datev-export-test-audit-secret-32chars'
  api = await import('./datevExport'); prisma = (await import('./persistence/client')).prisma
  await prisma.fiscalYear.create({ data: { id: 'fy-a', ownerId: 'tenant-a', year: 2026, startsAt: new Date('2026-01-01'), endsAt: new Date('2026-12-31') } })
  await prisma.ledgerProfile.create({ data: { ownerId: 'tenant-a', chart: 'SKR03', consultantNumber: '29098', clientNumber: '55003', accountLength: 4 } })
  await prisma.ledgerAccount.createMany({ data: [{ id: 'expense', ownerId: 'tenant-a', number: 4930, name: 'Office', category: 'EXPENSE' }, { id: 'tax', ownerId: 'tenant-a', number: 1576, name: 'Input VAT', category: 'ASSET' }, { id: 'vendor', ownerId: 'tenant-a', number: 70001, name: 'Supplier', category: 'LIABILITY' }] })
  await prisma.journalEntry.create({ data: { id: 'entry-a', ownerId: 'tenant-a', fiscalYearId: 'fy-a', sequenceNumber: 1, bookingDate: new Date('2026-07-23T12:00:00Z'), documentNumber: 'RE-1', description: 'Office invoice', lines: { create: [{ accountId: 'expense', debitCents: 10000 }, { accountId: 'tax', debitCents: 1900 }, { accountId: 'vendor', creditCents: 11900 }] } } })
})

afterAll(async () => { await prisma.$disconnect(); for (const key of ['DATABASE_URL', 'DOCUMENT_STORAGE_DRIVER', 'DOCUMENT_STORAGE_ROOT', 'AUDIT_INTEGRITY_SECRET']) delete process.env[key]; rmSync(directory, { recursive: true, force: true }) })

describe('persistent DATEV adviser export', () => {
  it('Given a tenant/year ledger, when export is repeated, then one retained immutable artifact round-trips exact cents', async () => {
    const first = await api.exportDatevBookingBatch('tenant-a', 'user-a', 2026, new Date('2026-08-04T12:00:00Z'))
    const replay = await api.exportDatevBookingBatch('tenant-a', 'user-a', 2026, new Date('2026-08-05T12:00:00Z'))
    expect(replay.bytes).toEqual(first.bytes); expect(replay.retainedArtifactId).toBe(first.retainedArtifactId)
    expect(parseDatevFiles([{ name: first.fileName, bytes: first.bytes }]).bookings.map(item => item.amountCents)).toEqual([10000, 1900])
    await expect(prisma.retainedArtifact.count({ where: { ownerId: 'tenant-a', objectType: 'DatevBookingBatch' } })).resolves.toBe(1)
    await expect(prisma.auditEvent.findFirst({ where: { ownerId: 'tenant-a', action: 'ARTIFACT_REGISTERED', objectType: 'DatevBookingBatch' } })).resolves.toBeTruthy()
    await expect(api.exportDatevBookingBatch('tenant-b', 'user-b', 2026)).rejects.toThrow(/does not exist/)
  })
})
