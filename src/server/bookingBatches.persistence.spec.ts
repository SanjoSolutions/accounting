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
    await expect(api.reviseBookingBatch(ownerId, 'actor-a', draft.id, { expectedVersion: 2, posting })).rejects.toThrow(/Editable draft not found/)
    await expect(prisma.journalEntry.update({ where: { id: posted.id }, data: { description: 'Rewritten history' } })).rejects.toThrow()
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
    await prisma.fiscalYear.create({ data: { ownerId: ownerA, year: 2026, startsAt: new Date('2026-01-01T00:00:00Z'), endsAt: new Date('2026-12-31T23:59:59Z') } })
    expect((await api.getBookingBatches(ownerA, 2026)).drafts).toEqual([])
    await expect(api.postBookingBatch(ownerA, 'actor-a', draftB.id)).rejects.toThrow(/not found/)
    await expect(api.reviseBookingBatch(ownerA, 'actor-a', draftB.id, { expectedVersion: 1, posting: draftB.payload })).rejects.toThrow(/not found/)
  })

  test('Given a draft changed after review, when posting the old version, then nothing is posted until the new version is reviewed', async () => {
    const ownerId = 'versioned-booking-owner'
    const workspace = await api.getBookingBatches(ownerId, 2026)
    const account = (number: number) => workspace.accounts.find(item => item.number === number)!.id
    await prisma.documentRecord.create({ data: { id: 'versioned-booking-document', ownerId, payload: '{}' } })
    const posting = { fiscalYear: 2026, bookingDate: '2026-08-10', description: 'Original review', documentIds: ['versioned-booking-document'], lines: [
      { accountId: account(4930), debitCents: 1000, creditCents: 0 }, { accountId: account(1200), debitCents: 0, creditCents: 1000 },
    ] }
    const draft = await api.createBookingBatch(ownerId, 'actor-a', posting)
    await api.reviseBookingBatch(ownerId, 'actor-b', draft.id, { expectedVersion: 1, posting: { ...posting, description: 'Revised review' } })
    await expect(api.postBookingBatch(ownerId, 'actor-a', draft.id, { expectedVersion: 1 })).rejects.toMatchObject({ status: 409 })
    expect(await prisma.journalEntry.count({ where: { ownerId } })).toBe(0)
    expect(await prisma.journalDraft.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({ status: 'DRAFT', version: 2 })
    const entry = await api.postBookingBatch(ownerId, 'actor-a', draft.id, { expectedVersion: 2 })
    expect(await prisma.journalEntry.findUniqueOrThrow({ where: { id: entry.id } })).toMatchObject({ description: 'Revised review' })
    expect((await api.postBookingBatch(ownerId, 'actor-a', draft.id, { expectedVersion: 2 })).id).toBe(entry.id)
    expect(await prisma.journalEntry.count({ where: { ownerId } })).toBe(1)
  })

  test('Given invalid references or a closed year, when posting, then all split lines remain unposted and the draft remains available', async () => {
    const ownerId = 'invalid-booking-owner'
    const workspace = await api.getBookingBatches(ownerId, 2026)
    const account = (number: number) => workspace.accounts.find(item => item.number === number)!.id
    await prisma.documentRecord.create({ data: { id: 'invalid-booking-document', ownerId, payload: '{}' } })
    const posting = { fiscalYear: 2026, bookingDate: '2026-08-10', description: 'Three split lines', documentIds: ['invalid-booking-document'], lines: [
      { accountId: account(4930), debitCents: 600, creditCents: 0 }, { accountId: account(4930), debitCents: 400, creditCents: 0 }, { accountId: account(1200), debitCents: 0, creditCents: 1000 },
    ] }
    const draft = await api.createBookingBatch(ownerId, 'actor-a', posting)
    for (const expectedVersion of [0, -1, 1.5, '1', null]) {
      await expect(api.postBookingBatch(ownerId, 'actor-a', draft.id, { expectedVersion })).rejects.toMatchObject({ status: 400 })
    }
    await prisma.ledgerAccount.update({ where: { id: account(4930) }, data: { active: false } })
    await expect(api.postBookingBatch(ownerId, 'actor-a', draft.id, { expectedVersion: 1 })).rejects.toThrow(/Konto/)
    await prisma.ledgerAccount.update({ where: { id: account(4930) }, data: { active: true } })
    await prisma.fiscalYear.update({ where: { id: workspace.fiscalYear.id }, data: { status: 'CLOSED' } })
    await expect(api.postBookingBatch(ownerId, 'actor-a', draft.id, { expectedVersion: 1 })).rejects.toThrow()
    expect(await prisma.journalEntry.count({ where: { ownerId } })).toBe(0)
    expect(await prisma.journalLine.count({ where: { account: { ownerId } } })).toBe(0)
    expect(await prisma.journalDraft.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({ status: 'DRAFT', version: 1 })
  })
})
