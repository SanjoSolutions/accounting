import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const directory = mkdtempSync(join(tmpdir(), 'accounting-booking-batches-'))
const databasePath = join(directory, 'test.db').replace(/\\/g, '/')
let api: typeof import('./bookingBatches')
let prisma: typeof import('@/server/persistence/client').prisma

beforeAll(async () => {
  const database = new DatabaseSync(databasePath)
  const root = resolve(process.cwd(), 'prisma', 'migrations')
  for (const name of readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort()) database.exec(readFileSync(join(root, name, 'migration.sql'), 'utf8'))
  database.close()
  process.env.DATABASE_URL = `file:${databasePath}`
  api = await import('./bookingBatches')
  prisma = (await import('@/server/persistence/client')).prisma
})

afterAll(async () => {
  await prisma.$disconnect()
  delete process.env.DATABASE_URL
  rmSync(directory, { recursive: true, force: true })
})

describe('booking batch persistence', () => {
  test('keeps a manual booking editable and out of the journal until explicit posting', async () => {
    const ownerId = 'booking-batch-owner'
    const workspace = await api.getBookingBatches(ownerId, 2026)
    const account = (number: number) => workspace.accounts.find(item => item.number === number)!.id
    await prisma.documentRecord.create({ data: { id: 'booking-batch-document', ownerId, payload: JSON.stringify({ id: 'booking-batch-document', url: '/api/documents/booking-batch-document/file', fileName: 'receipt.pdf', contentType: 'application/pdf', size: 42 }) } })

    const posting = {
      fiscalYear: 2026,
      bookingDate: '2026-08-10',
      description: 'Draft booking',
      documentIds: ['booking-batch-document'],
      lines: [
        { accountId: account(1000), debitCents: 1000, creditCents: 0 },
        { accountId: account(4930), debitCents: 0, creditCents: 1000 },
      ],
    }
    const draft = await api.createBookingBatch(ownerId, 'actor-a', posting)
    expect(draft).toMatchObject({ status: 'DRAFT', version: 1, ownerId, fiscalYearId: workspace.fiscalYear.id })
    expect(await prisma.journalEntry.count({ where: { ownerId } })).toBe(0)

    const listed = await api.getBookingBatches(ownerId, 2026)
    expect(listed.drafts).toHaveLength(1)
    expect(listed.drafts[0]).toMatchObject({ id: draft.id, version: 1, posting: { documentNumber: `DRAFT-${draft.id}` }, documents: [{ id: 'booking-batch-document', fileName: 'receipt.pdf', contentType: 'application/pdf', size: 42 }] })

    const revised = await api.reviseBookingBatch(ownerId, 'actor-a', draft.id, {
      expectedVersion: 1,
      posting: { ...posting, description: 'Reviewed draft' },
    })
    expect(revised).toMatchObject({ id: draft.id, version: 2, status: 'DRAFT' })
    await expect(api.reviseBookingBatch(ownerId, 'actor-a', draft.id, { expectedVersion: 1, posting: { ...posting, description: 'Stale edit' } })).rejects.toThrow(/concurrently/)

    const posted = await api.postBookingBatch(ownerId, 'actor-a', draft.id)
    expect(posted).toMatchObject({ documentNumber: expect.stringMatching(/^JOURNAL-/) })
    expect(await prisma.journalEntry.count({ where: { ownerId } })).toBe(1)
    expect(await prisma.journalDraft.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({ status: 'POSTED', postedEntryId: posted.id })

    const retried = await api.postBookingBatch(ownerId, 'actor-a', draft.id)
    expect(retried.id).toBe(posted.id)
    expect(await prisma.journalEntry.count({ where: { ownerId } })).toBe(1)
    expect((await api.getBookingBatches(ownerId, 2026)).drafts).toHaveLength(0)
  })

  test('does not expose another tenant draft or document metadata', async () => {
    const ownerA = 'booking-batch-isolation-a'
    const ownerB = 'booking-batch-isolation-b'
    const workspaceA = await api.getBookingBatches(ownerA, 2027)
    const workspaceB = await api.getBookingBatches(ownerB, 2027)
    const account = (workspace: typeof workspaceA, number: number) => workspace.accounts.find(item => item.number === number)!.id
    await prisma.documentRecord.create({ data: { id: 'booking-batch-private-b', ownerId: ownerB, payload: JSON.stringify({ fileName: 'private.pdf', storageKey: 'must-not-leak' }) } })
    const draftB = await api.createBookingBatch(ownerB, 'actor-b', { fiscalYear: 2027, bookingDate: '2027-01-02', description: 'Private', documentIds: ['booking-batch-private-b'], lines: [{ accountId: account(workspaceB, 1000), debitCents: 100, creditCents: 0 }, { accountId: account(workspaceB, 4930), debitCents: 0, creditCents: 100 }] })
    await api.createBookingBatch(ownerA, 'actor-a', { fiscalYear: 2027, bookingDate: '2027-01-03', description: 'Own', lines: [{ accountId: account(workspaceA, 1000), debitCents: 100, creditCents: 0 }, { accountId: account(workspaceA, 4930), debitCents: 0, creditCents: 100 }] })

    const listedA = await api.getBookingBatches(ownerA, 2027)
    expect(listedA.drafts.every(draft => draft.id !== draftB.id)).toBe(true)
    expect(listedA.drafts[0].documents).toEqual([])
  })
})
