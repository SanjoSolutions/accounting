import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { createOpeningBalanceLines, type FinancialStatements, type OpeningBalanceLine } from '@/core/doubleEntry'
import { sha256 } from './compliance/retention'

vi.mock('server-only', () => ({}))
// This suite isolates carry-forward persistence from annual HGB approval. The
// generation, posting, correction, reopen, retention and audit writes are real.
vi.mock('./hgbCloseRepository', () => ({
  requireCurrentReadyHgbClose: async (transaction: typeof prisma, ownerId: string, period: { id: string }) =>
    transaction.hgbCloseRun.findFirstOrThrow({ where: { ownerId, fiscalPeriodId: period.id }, orderBy: { version: 'desc' } }),
}))

const directory = mkdtempSync(join(tmpdir(), 'accounting-opening-balances-'))
const databasePath = join(directory, 'test.db').replace(/\\/g, '/')
const storageRoot = join(directory, 'documents')
let api: typeof import('./ledger')
let compliance: typeof import('./compliance/runtime')
let prisma: typeof import('./persistence/client').prisma
let tenantSequence = 0

beforeAll(async () => {
  const database = new DatabaseSync(databasePath)
  const migrations = resolve(process.cwd(), 'prisma', 'migrations')
  for (const name of readdirSync(migrations, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort()) {
    database.exec(readFileSync(join(migrations, name, 'migration.sql'), 'utf8'))
  }
  database.close()
  vi.stubEnv('DATABASE_URL', `file:${databasePath}`)
  vi.stubEnv('DOCUMENT_STORAGE_DRIVER', 'fs')
  vi.stubEnv('DOCUMENT_STORAGE_ROOT', storageRoot)
  vi.stubEnv('DOCUMENT_STORAGE_OPTIONS', '{}')
  vi.stubEnv('COMPLIANCE_E2E_REFERENCE_DATE', '2027-01-15')
  api = await import('./ledger')
  compliance = await import('./compliance/runtime')
  prisma = (await import('./persistence/client')).prisma
})

afterAll(async () => {
  await prisma?.$disconnect()
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

async function fixture() {
  const ownerId = `opening-tenant-${++tenantSequence}`
  const workspace = await api.getLedgerWorkspace(ownerId, 2025)
  const account = (number: number) => workspace.accounts.find(item => item.number === number)!.id
  const period = await prisma.fiscalYear.findUniqueOrThrow({ where: { ownerId_year: { ownerId, year: 2025 } } })
  await prisma.hgbCloseRun.create({ data: {
    ownerId, fiscalPeriodId: period.id, version: 1, status: 'READY_TO_LOCK', ruleSetVersion: 'test',
    ledgerFingerprint: 'synthetic', inputChecksum: 'synthetic', checksum: 'synthetic-hgb', payload: '{}', createdBy: 'reviewer',
  } })
  const posting = (amount: number, year = 2025, documentNumber = 'CONTRIBUTION') => ({
    fiscalYear: year, bookingDate: `${year}-06-01`, documentNumber, description: 'Synthetic equity contribution',
    lines: [
      { accountId: account(1200), debitCents: Math.max(amount, 0), creditCents: Math.max(-amount, 0) },
      { accountId: account(2900), debitCents: Math.max(-amount, 0), creditCents: Math.max(amount, 0) },
    ],
  })
  const post = async (amount: number, year = 2025, documentNumber = 'CONTRIBUTION') => {
    const documentId = `${ownerId}-${documentNumber}`
    await prisma.documentRecord.create({ data: { id: documentId, ownerId, payload: '{}' } })
    return api.postJournalEntry(ownerId, { ...posting(amount, year, documentNumber), documentIds: [documentId] })
  }
  const reopen = async () => {
    const request = await compliance.requestPeriodReopen(ownerId, 'requester', period.id, 'Correct synthetic contribution')
    await compliance.decidePeriodReopen(ownerId, 'independent-reviewer', request.id, true, 'Approved synthetic correction')
  }
  const correct = (originalId: string, amount: number, documentNumber = 'CORRECTED') =>
    compliance.correctPostedEntry(ownerId, 'bookkeeper', originalId, { reason: 'Correct synthetic amount', replacement: posting(amount, 2025, documentNumber) })
  const openings = () => prisma.journalEntry.findMany({ where: { ownerId, source: 'OPENING' }, include: { lines: true }, orderBy: { sequenceNumber: 'asc' } })
  const generations = () => prisma.fiscalCloseGeneration.findMany({ where: { ownerId, fiscalYearId: period.id }, orderBy: { generation: 'asc' } })
  const close = () => api.closeFiscalYear(ownerId, 2025) as Promise<FinancialStatements>
  const original = await post(10000)
  return { ownerId, account, period, posting, post, reopen, correct, openings, generations, close, original }
}

function balances(lines: OpeningBalanceLine[]) {
  const result = new Map<string, number>()
  for (const line of lines) result.set(line.accountId, (result.get(line.accountId) ?? 0) + line.debitCents - line.creditCents)
  return Object.fromEntries([...result].filter(([, cents]) => cents !== 0).sort(([a], [b]) => a.localeCompare(b)))
}

async function expectReconciliation(f: Awaited<ReturnType<typeof fixture>>, snapshot: FinancialStatements, ownLines: OpeningBalanceLine[] = []) {
  const openings = await f.openings()
  const expected = createOpeningBalanceLines(snapshot)
  expect(balances(openings.flatMap(entry => entry.lines))).toEqual(balances(expected))
  const all = await prisma.journalEntry.findMany({ where: { ownerId: f.ownerId, fiscalYear: { year: 2026 } }, include: { lines: true } })
  expect(balances(all.flatMap(entry => entry.lines))).toEqual(balances([...expected, ...ownLines]))
  const generations = await f.generations()
  const current = generations.at(-1)!
  const closed = await prisma.fiscalYear.findUniqueOrThrow({ where: { id: f.period.id } })
  expect(current.snapshotHash).toBe(sha256(closed.closingSnapshot!))
  expect(closed.status).toBe('CLOSED')
  const audit = await prisma.auditEvent.findFirstOrThrow({
    where: { ownerId: f.ownerId, action: 'FISCAL_PERIOD_CLOSED' }, orderBy: { occurredAt: 'desc' },
  })
  expect(JSON.parse(audit.semanticDelta).after).toMatchObject({
    closeGenerationId: current.id,
    openingEntryId: openings.find(entry => entry.externalKey === `OPENING:${f.period.id}:${current.id}`)?.id ?? null,
  })
  const retained = await prisma.retainedArtifact.findFirstOrThrow({
    where: { ownerId: f.ownerId, objectType: 'ClosingSnapshot' }, orderBy: { version: 'desc' },
  })
  expect(readFileSync(join(storageRoot, retained.storageKey!), 'utf8')).toBe(closed.closingSnapshot)
  for (const opening of openings) {
    if (opening.externalKey === `OPENING:${f.period.id}`) continue // immutable legacy carry-forward
    expect(generations.some(generation => opening.externalKey === `OPENING:${f.period.id}:${generation.id}`)).toBe(true)
  }
}

describe('successor opening balance persistence', () => {
  test('Given a corrected predecessor and successor postings, when reclosed and retried, then generation deltas reconcile without rewriting or duplicating journals', async () => {
    const f = await fixture()
    await f.close()
    const initial = await f.openings()
    const ownPosting = await f.post(5000, 2026, 'SUCCESSOR-ACTIVITY')
    await f.reopen()
    const correction = await f.correct(f.original.id, 20000)
    const snapshot = await f.close()
    expect(snapshot.assetsCents).toBe(20000)
    await expectReconciliation(f, snapshot, ownPosting.lines)
    const openings = await f.openings()
    expect(openings).toHaveLength(2)
    expect(openings[0]).toEqual(initial[0])
    expect(balances(openings[1].lines)).toEqual(balances(f.posting(10000).lines))
    expect(openings[1].sequenceNumber).toBe(ownPosting.sequenceNumber + 1)
    expect(await prisma.journalEntry.findUnique({ where: { id: ownPosting.id }, include: { lines: true, documents: true } })).toEqual(ownPosting)
    const generations = await f.generations()
    expect(generations).toHaveLength(2)
    for (let retry = 0; retry < 3; retry++) expect(await f.close()).toEqual(snapshot)
    expect(await f.openings()).toEqual(openings)
    expect(await f.generations()).toEqual(generations)
    expect(await prisma.auditEvent.count({ where: { ownerId: f.ownerId, action: 'FISCAL_PERIOD_CLOSED' } })).toBe(2)

    // A third close must subtract the aggregate of all earlier carry-forwards.
    await f.reopen()
    await f.correct(correction.replacement.id, 8000, 'CORRECTED-AGAIN')
    const thirdSnapshot = await f.close()
    expect(thirdSnapshot.assetsCents).toBe(8000)
    await expectReconciliation(f, thirdSnapshot, ownPosting.lines)
    expect((await f.openings()).slice(0, 2)).toEqual(openings)
  })

  test('Given an initially zero opening, when a correction makes it nonzero, then reclose creates one generation-bound carry-forward despite retries', async () => {
    const f = await fixture()
    await f.post(-10000, 2025, 'WITHDRAWAL')
    expect((await f.close()).assetsCents).toBe(0)
    expect(await f.openings()).toHaveLength(0)
    await f.reopen()
    await f.correct(f.original.id, 20000)
    const snapshot = await f.close()
    expect(snapshot.assetsCents).toBe(10000)
    await expectReconciliation(f, snapshot)
    for (let retry = 0; retry < 3; retry++) await f.close()
    expect(await f.openings()).toHaveLength(1)
    expect(await f.generations()).toHaveLength(2)
    expect((await f.openings())[0].externalKey).toBe(`OPENING:${f.period.id}:${(await f.generations())[1].id}`)
  })

  test('Given a nonzero opening, when a correction clears every balance, then an immutable delta cancels the original opening', async () => {
    const f = await fixture()
    await f.post(-5000, 2025, 'WITHDRAWAL')
    await f.close()
    const initial = await f.openings()
    await f.reopen()
    await f.correct(f.original.id, 5000)
    const snapshot = await f.close()
    expect(snapshot.assetsCents).toBe(0)
    await expectReconciliation(f, snapshot)
    const openings = await f.openings()
    expect(openings).toHaveLength(2)
    expect(openings[0]).toEqual(initial[0])
  })

  test('Given an unchanged reopened year, when closed again, then it records a new generation without a redundant zero journal', async () => {
    const f = await fixture()
    await f.close()
    const initial = await f.openings()
    await f.reopen()
    await expectReconciliation(f, await f.close())
    expect(await f.openings()).toEqual(initial)
    expect(await f.generations()).toHaveLength(2)
  })

  test('Given a corrected expense, when the predecessor is reclosed, then the successor carries the changed result into equity without expense balances', async () => {
    const f = await fixture()
    const expense = (amount: number) => ({
      fiscalYear: 2025, bookingDate: '2025-07-01', documentNumber: 'EXPENSE', description: 'Synthetic expense',
      lines: [
        { accountId: f.account(4930), debitCents: amount, creditCents: 0 },
        { accountId: f.account(1200), debitCents: 0, creditCents: amount },
      ],
    })
    const originalExpense = await api.postJournalEntry(f.ownerId, { ...expense(2000), documentIds: [`${f.ownerId}-CONTRIBUTION`] })
    await f.close()
    await f.reopen()
    await compliance.correctPostedEntry(f.ownerId, 'bookkeeper', originalExpense.id, {
      reason: 'Correct synthetic expense', replacement: { ...expense(5000), documentNumber: 'EXPENSE-CORRECTED' },
    })
    const snapshot = await f.close()
    expect(snapshot).toMatchObject({ assetsCents: 5000, netIncomeCents: -5000, equityCents: 5000 })
    await expectReconciliation(f, snapshot)
    expect(balances((await f.openings()).flatMap(entry => entry.lines))).toEqual({ [f.account(1200)]: 5000, [f.account(2900)]: -5000 })
  })

  test('Given a retained legacy opening without a generation, when corrected and reclosed, then the delta includes the legacy balance and preserves its journal', async () => {
    const f = await fixture()
    const successor = await prisma.fiscalYear.create({ data: {
      ownerId: f.ownerId, year: 2026, startsAt: new Date('2026-01-01'), endsAt: new Date('2026-12-31T23:59:59.999Z'),
    } })
    const legacy = await prisma.journalEntry.create({ data: {
      ownerId: f.ownerId, fiscalYearId: successor.id, sequenceNumber: 1, source: 'OPENING',
      externalKey: `OPENING:${f.period.id}`, bookingDate: new Date('2026-01-01T12:00:00Z'),
      documentNumber: 'SYS-EB-LEGACY', description: 'Synthetic legacy opening', lines: { create: f.posting(10000).lines },
    }, include: { lines: true } })
    await prisma.fiscalYear.update({ where: { id: f.period.id }, data: { status: 'CLOSED', lockedAt: new Date('2026-01-02'), closingSnapshot: '{"assetsCents":10000}' } })
    await f.reopen()
    await f.correct(f.original.id, 20000)
    await expectReconciliation(f, await f.close())
    const openings = await f.openings()
    expect(openings).toHaveLength(2)
    expect(openings[0]).toEqual(legacy)
    await f.close()
    expect(await f.openings()).toEqual(openings)
  })

  test('Given a persistence failure after the delta, when close is retried, then the failed generation, delta, snapshot and close audit roll back together', async () => {
    const f = await fixture()
    await f.close()
    await f.reopen()
    await f.correct(f.original.id, 20000)
    const openings = await f.openings()
    const generations = await f.generations()
    const period = await prisma.fiscalYear.findUniqueOrThrow({ where: { id: f.period.id } })
    const artifacts = await prisma.retainedArtifact.findMany({ where: { ownerId: f.ownerId, objectType: 'ClosingSnapshot' } })
    const audits = await prisma.auditEvent.findMany({ where: { ownerId: f.ownerId } })
    const storedSnapshots = () => readdirSync(join(storageRoot, 'closing-snapshots', f.ownerId)).sort()
    const files = storedSnapshots()
    await prisma.$executeRawUnsafe(`CREATE TRIGGER "test_fail_close_retention" BEFORE INSERT ON "RetainedArtifact" WHEN NEW."objectType" = 'ClosingSnapshot' BEGIN SELECT RAISE(ABORT, 'synthetic close failure'); END`)
    try {
      await expect(f.close()).rejects.toThrow()
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER "test_fail_close_retention"')
    }
    expect(await f.openings()).toEqual(openings)
    expect(await f.generations()).toEqual(generations)
    expect(await prisma.fiscalYear.findUniqueOrThrow({ where: { id: f.period.id } })).toEqual(period)
    expect(await prisma.retainedArtifact.findMany({ where: { ownerId: f.ownerId, objectType: 'ClosingSnapshot' } })).toEqual(artifacts)
    expect(await prisma.auditEvent.findMany({ where: { ownerId: f.ownerId } })).toEqual(audits)
    expect(storedSnapshots()).toEqual(files)
    await expectReconciliation(f, await f.close())
    await f.close()
    expect(await f.openings()).toHaveLength(2)
    expect(await f.generations()).toHaveLength(2)
  })

  test.each(['CLOSED', 'CLOSING', 'REOPENED'])('Given a %s successor, when the corrected predecessor is reclosed, then no carry-forward or generation is committed', async status => {
    const f = await fixture()
    await f.close()
    await f.reopen()
    await f.correct(f.original.id, 20000)
    const openings = await f.openings()
    const generations = await f.generations()
    await prisma.fiscalYear.update({ where: { ownerId_year: { ownerId: f.ownerId, year: 2026 } }, data: { status } })
    await expect(f.close()).rejects.toThrow(/bereits gesperrte Geschäftsjahr/)
    expect(await f.openings()).toEqual(openings)
    expect(await f.generations()).toEqual(generations)
    expect((await prisma.fiscalYear.findUniqueOrThrow({ where: { id: f.period.id } })).status).toBe('REOPENED')
  })
})
