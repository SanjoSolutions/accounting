import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const directory = mkdtempSync(join(tmpdir(), 'accounting-ledger-vat-'))
const databasePath = join(directory, 'test.db').replace(/\\/g, '/')
let api: typeof import('./ledger')
let prisma: typeof import('@/server/persistence/client').prisma

beforeAll(async () => {
  const database = new DatabaseSync(databasePath)
  const root = resolve(process.cwd(), 'prisma', 'migrations')
  for (const name of readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort()) database.exec(readFileSync(join(root, name, 'migration.sql'), 'utf8'))
  database.close()
  process.env.DATABASE_URL = `file:${databasePath}`
  api = await import('./ledger')
  prisma = (await import('@/server/persistence/client')).prisma
})
afterAll(async () => { await prisma.$disconnect(); delete process.env.DATABASE_URL; rmSync(directory, { recursive: true, force: true }) })

describe('taxable journal posting persistence', () => {
  it('atomically posts a 100 EUR net sale with 19 EUR output VAT and immutable provenance', async () => {
    const workspace = await api.getLedgerWorkspace('tenant-taxable', 2026)
    const account = (number: number) => workspace.accounts.find(item => item.number === number)!.id
    await prisma.documentRecord.create({ data: { id: 'sale-document', ownerId: 'tenant-taxable', payload: '{}' } })
    const entry = await api.postJournalEntry('tenant-taxable', {
      fiscalYear: 2026, bookingDate: '2026-08-04', description: 'Taxable consulting sale', documentIds: ['sale-document'],
      lines: [
        { accountId: account(1400), debitCents: 11900, creditCents: 0 },
        { accountId: account(8400), debitCents: 0, creditCents: 10000, vat: { ruleId: 'DE_STANDARD', mode: 'net', direction: 'sale' } },
        { accountId: account(1776), debitCents: 0, creditCents: 1900 },
      ],
    })
    const persisted = await prisma.journalEntry.findUniqueOrThrow({ where: { id: entry.id }, include: { lines: { include: { account: true, vatPosting: true } } } })
    const revenue = persisted.lines.find(line => line.account.number === 8400)!
    expect(persisted.state).toBe('POSTED')
    expect(revenue).toMatchObject({ creditCents: 10000, taxCode: 'DE_STANDARD', netBaseCents: 10000, taxAmountCents: 1900, taxRuleVersion: 1, vatPosting: { ownerId: 'tenant-taxable', journalLineId: revenue.id, documentId: 'sale-document', outputTaxCents: 1900, ruleId: 'DE_STANDARD' } })
    expect(revenue.vatPosting?.sourceId).toBe(`journal:${entry.id}:line:${revenue.id}`)
    expect(await prisma.vatReversalMarker.count({ where: { ownerId: 'tenant-taxable' } })).toBeGreaterThan(0)
    const auditEvents = await prisma.auditEvent.findMany({ where: { ownerId: 'tenant-taxable' }, orderBy: { occurredAt: 'asc' } })
    const auditHead = await prisma.auditHead.findUnique({ where: { ownerId: 'tenant-taxable' } })
    expect(auditEvents).toHaveLength(1)
    expect(auditEvents[0]).toMatchObject({ actorId: 'tenant-taxable', action: 'JOURNAL_ENTRY_POSTED', objectType: 'JournalEntry', objectId: entry.id })
    expect((await import('./compliance/auditPersistence')).verifyAuditChain(auditEvents, auditHead)).toBe(true)
  })

  it('rolls back the entire booking when its VAT control line does not reconcile', async () => {
    const workspace = await api.getLedgerWorkspace('tenant-rollback', 2026)
    const account = (number: number) => workspace.accounts.find(item => item.number === number)!.id
    await prisma.documentRecord.create({ data: { id: 'bad-sale-document', ownerId: 'tenant-rollback', payload: '{}' } })
    await expect(api.postJournalEntry('tenant-rollback', {
      fiscalYear: 2026, bookingDate: '2026-08-05', description: 'Broken taxable sale', documentIds: ['bad-sale-document'],
      lines: [
        { accountId: account(1400), debitCents: 11900, creditCents: 0 },
        { accountId: account(8400), debitCents: 0, creditCents: 10000, vat: { ruleId: 'DE_STANDARD', mode: 'net', direction: 'sale' } },
        { accountId: account(1776), debitCents: 0, creditCents: 1800 },
        { accountId: account(2900), debitCents: 0, creditCents: 100 },
      ],
    })).rejects.toThrow(/1900 Cent/)
    expect(await prisma.journalEntry.count({ where: { fiscalYear: { ownerId: 'tenant-rollback' } } })).toBe(0)
    expect(await prisma.vatPostingRecord.count({ where: { ownerId: 'tenant-rollback' } })).toBe(0)
    expect(await prisma.vatReversalMarker.count({ where: { ownerId: 'tenant-rollback' } })).toBe(0)
  })
})
