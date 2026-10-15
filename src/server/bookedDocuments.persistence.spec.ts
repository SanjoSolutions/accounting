import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const directory = mkdtempSync(join(tmpdir(), 'accounting-booked-documents-'))
let ledger: typeof import('./ledger')
let library: typeof import('./bookedDocuments')
let documents: typeof import('./index')
let prisma: typeof import('./persistence/client').prisma

beforeAll(async () => {
  const databasePath = join(directory, 'test.db').replaceAll('\\', '/')
  const database = new DatabaseSync(databasePath)
  const root = resolve('prisma/migrations')
  for (const name of readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort()) {
    database.exec(readFileSync(join(root, name, 'migration.sql'), 'utf8'))
  }
  database.close()
  vi.stubEnv('DATABASE_URL', `file:${databasePath}`)
  vi.stubEnv('DOCUMENT_STORAGE_DRIVER', 'fs')
  vi.stubEnv('DOCUMENT_STORAGE_ROOT', join(directory, 'documents'))
  ledger = await import('./ledger')
  library = await import('./bookedDocuments')
  documents = await import('./index')
  prisma = (await import('./persistence/client')).prisma
}, 120_000)

afterAll(async () => {
  await prisma?.$disconnect()
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

describe('retained booked document browsing and reuse', () => {
  test('Given retained evidence used for a posting, when it is found and reused, then both journal links and the original audit history remain intact', async () => {
    const owner = 'booked-evidence-owner'
    const workspace = await ledger.getLedgerWorkspace(owner, 2026)
    const document = await documents.createDocument({ content: readFileSync(resolve('e2e/fixtures/invoice.pdf')), contentType: 'application/pdf', fileName: 'Synthetic evidence.pdf' }, owner)
    const posting = {
      fiscalYear: 2026, bookingDate: '2026-02-01', description: 'First use', documentIds: [document.id],
      lines: [
        { accountId: workspace.accounts.find(account => account.number === 4930)!.id, debitCents: 1000, creditCents: 0 },
        { accountId: workspace.accounts.find(account => account.number === 1200)!.id, debitCents: 0, creditCents: 1000 },
      ],
    }
    expect((await documents.listDocuments(owner)).map(item => item.id)).toContain(document.id)
    expect(await library.listBookedDocuments(owner)).toEqual([])
    const original = await ledger.postJournalEntry(owner, posting)
    const beforeEntry = await prisma.journalEntry.findUniqueOrThrow({ where: { id: original.id }, include: { documents: true, lines: true } })
    const beforeDocument = await prisma.documentRecord.findUniqueOrThrow({ where: { id: document.id } })
    const beforeRetention = await prisma.retainedArtifact.findMany({ where: { ownerId: owner, objectId: document.id } })
    const beforeAudit = await prisma.auditEvent.findMany({ where: { ownerId: owner }, orderBy: { occurredAt: 'asc' } })

    expect(await documents.listDocuments(owner)).toEqual([])
    const booked = await library.listBookedDocuments(owner)
    expect(booked).toHaveLength(1)
    expect(booked[0]).toMatchObject({ id: document.id, fileName: 'Synthetic evidence.pdf', bookings: [{ id: original.id, fiscalYear: 2026, state: 'POSTED', description: 'First use', bookingDate: '2026-02-01' }] })
    expect(booked[0]).not.toHaveProperty('storageKey')
    expect(booked[0]).not.toHaveProperty('ownerId')
    expect(await library.listBookedDocuments('other-tenant')).toEqual([])
    await expect(documents.readDocumentFile(document.id, 'other-tenant')).resolves.toBeNull()

    const reused = await ledger.postJournalEntry(owner, { ...posting, bookingDate: '2026-02-02', description: 'Second use' })
    expect((await library.listBookedDocuments(owner))[0].bookings.map(entry => entry.id)).toEqual([reused.id, original.id])
    expect(await documents.listDocuments(owner)).toEqual([])
    expect(await prisma.journalEntry.findUniqueOrThrow({ where: { id: original.id }, include: { documents: true, lines: true } })).toEqual(beforeEntry)
    expect(await prisma.documentRecord.findUniqueOrThrow({ where: { id: document.id } })).toEqual(beforeDocument)
    expect(await prisma.retainedArtifact.findMany({ where: { ownerId: owner, objectId: document.id } })).toEqual(beforeRetention)
    expect(await prisma.auditEvent.findMany({ where: { id: { in: beforeAudit.map(event => event.id) } }, orderBy: { occurredAt: 'asc' } })).toEqual(beforeAudit)
    const events = await prisma.auditEvent.findMany({ where: { ownerId: owner }, orderBy: { occurredAt: 'asc' } })
    const head = await prisma.auditHead.findUnique({ where: { ownerId: owner } })
    expect((await import('./compliance/auditPersistence')).verifyAuditChain(events, head)).toBe(true)

    const foreignWorkspace = await ledger.getLedgerWorkspace('other-tenant', 2026)
    await expect(ledger.postJournalEntry('other-tenant', { ...posting, lines: posting.lines.map((line, index) => ({ ...line, accountId: foreignWorkspace.accounts.find(account => account.number === (index === 0 ? 4930 : 1200))!.id })) })).rejects.toThrow(/anderen Mandanten/)
    expect(await prisma.journalDocumentAttachment.count({ where: { documentId: document.id } })).toBe(2)
  }, 120_000)
})
