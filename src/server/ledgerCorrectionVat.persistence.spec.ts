import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const directory = mkdtempSync(join(tmpdir(), 'accounting-correction-vat-'))
const databasePath = join(directory, 'test.db').replace(/\\/g, '/')
let ledger: typeof import('./ledger')
let runtime: typeof import('./compliance/runtime')
let prisma: typeof import('./persistence/client').prisma

beforeAll(async () => {
  const database = new DatabaseSync(databasePath)
  // Only schema setup skips fsync. The application opens a new connection with
  // normal durability for every persistence/rollback assertion below.
  database.exec('PRAGMA synchronous = OFF')
  const migrations = resolve('prisma/migrations')
  for (const name of readdirSync(migrations, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort()) {
    database.exec(readFileSync(join(migrations, name, 'migration.sql'), 'utf8'))
  }
  database.close()
  vi.stubEnv('DATABASE_URL', `file:${databasePath}`)
  vi.stubEnv('DOCUMENT_STORAGE_DRIVER', 'fs')
  vi.stubEnv('DOCUMENT_STORAGE_ROOT', join(directory, 'documents'))
  ledger = await import('./ledger')
  runtime = await import('./compliance/runtime')
  prisma = (await import('./persistence/client')).prisma
})

afterAll(async () => {
  await prisma?.$disconnect()
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

async function fixture(ownerId: string, bookingDate = '2026-08-04') {
  const workspace = await ledger.getLedgerWorkspace(ownerId, Number(bookingDate.slice(0, 4)))
  const account = (number: number) => workspace.accounts.find(item => item.number === number)!.id
  const documentId = `${ownerId}-document`
  await prisma.documentRecord.create({ data: { id: documentId, ownerId, payload: '{}' } })
  const input = (net = 10000, ruleId = 'DE_STANDARD', date = bookingDate) => {
    const reduced = ruleId === 'DE_REDUCED'
    const tax = Math.round(net * (reduced ? 0.07 : 0.19))
    return {
      bookingDate: date, documentNumber: `replacement-${ownerId}`, description: 'Synthetic taxable sale', documentIds: [documentId],
      lines: [
        { accountId: account(1400), debitCents: net + tax, creditCents: 0 },
        { accountId: account(reduced ? 8300 : 8400), debitCents: 0, creditCents: net, vat: { ruleId, mode: 'net' as const, direction: 'sale' as const } },
        { accountId: account(reduced ? 1771 : 1776), debitCents: 0, creditCents: tax },
      ],
    }
  }
  const original = await ledger.postJournalEntry(ownerId, input())
  const correct = (replacement = input(20000)) => runtime.correctPostedEntry(ownerId, 'correcting-actor', original.id, { reason: 'Correct synthetic amount', replacement })
  return { ownerId, documentId, original, input, correct, account }
}

async function expectReconciled(ownerId: string, expected: number, month?: string, direction: 'output' | 'input' = 'output') {
  const start = month ? new Date(`${month}-01`) : undefined
  const range = start ? { gte: start, lt: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)) } : undefined
  const controls = await prisma.journalLine.findMany({ where: { journalEntry: { ownerId, ...(range ? { bookingDate: range } : {}) }, account: { number: { in: direction === 'output' ? [1771, 1776] : [1571, 1576] } } } })
  const postings = await prisma.vatPostingRecord.findMany({ where: { ownerId, ...(range ? { taxPoint: range } : {}) } })
  expect(controls.reduce((sum, line) => sum + (direction === 'output' ? line.creditCents - line.debitCents : line.debitCents - line.creditCents), 0)).toBe(expected)
  expect(postings.reduce((sum, row) => sum + (direction === 'output' ? row.outputTaxCents : row.inputTaxCents), 0)).toBe(expected)
}

async function snapshot(ownerId: string) {
  return {
    entries: await prisma.journalEntry.findMany({ where: { ownerId }, include: { lines: true, documents: true }, orderBy: { id: 'asc' } }),
    postings: await prisma.vatPostingRecord.findMany({ where: { ownerId }, orderBy: { sourceId: 'asc' } }),
    markers: await prisma.vatReversalMarker.findMany({ where: { ownerId }, orderBy: { marker: 'asc' } }),
    audit: await prisma.auditEvent.findMany({ where: { ownerId }, orderBy: { occurredAt: 'asc' } }),
    head: await prisma.auditHead.findUnique({ where: { ownerId } }),
    periods: await prisma.fiscalYear.findMany({ where: { ownerId }, orderBy: { year: 'asc' } }),
  }
}

describe('VAT-aware journal correction persistence', () => {
  test('given a taxable sale, correcting the net amount atomically reconciles VAT evidence and ledger controls', async () => {
    const f = await fixture('correction-amount')
    const before = await snapshot(f.ownerId)
    const result = await f.correct()
    expect(await prisma.vatPostingRecord.count({ where: { ownerId: f.ownerId } })).toBe(3)
    await expectReconciled(f.ownerId, 3800)
    const reversal = await prisma.journalLine.findFirstOrThrow({ where: { journalEntryId: result.reversal.id, accountId: f.account(8400) }, include: { vatPosting: true } })
    const originalVat = await prisma.vatPostingRecord.findFirstOrThrow({ where: { ownerId: f.ownerId, journalLine: { journalEntryId: f.original.id } } })
    expect(reversal).toMatchObject({ netBaseCents: -10000, taxAmountCents: -1900, taxRuleVersion: 1, vatPosting: { documentId: f.documentId, outputTaxCents: -1900 } })
    expect(JSON.parse(reversal.vatPosting!.source)).toMatchObject({ reversalOf: originalVat.sourceId, originalTaxPoint: '2026-08-04', taxPoint: '2026-08-04' })
    expect(result.reversal.documents.map(item => item.documentId)).toEqual([f.documentId])
    const after = await snapshot(f.ownerId)
    expect(after.entries.find(entry => entry.id === f.original.id)).toEqual(before.entries[0])
    expect(after.postings.find(posting => posting.id === originalVat.id)).toEqual(before.postings[0])
    expect(after.markers).toHaveLength(7)
    expect(after.audit).toHaveLength(2)
    expect(after.audit[1]).toMatchObject({ actorId: 'correcting-actor', action: 'JOURNAL_ENTRY_CORRECTED' })
    expect((await import('./compliance/auditPersistence')).verifyAuditChain(after.audit, after.head)).toBe(true)
    // Read through the normal VAT repository to verify durable reversal bindings.
    const persisted = reversal.vatPosting!
    const detail = JSON.parse(persisted.source)
    const restored = await (await import('./tax/vatRepository')).persistVatPosting(f.ownerId, { ...detail, amountCents: Math.abs(detail.amountCents), journalLineId: reversal.id, documentId: f.documentId })
    expect(restored).toMatchObject({ taxCents: -1900, ruleVersion: 1, reversalOf: originalVat.sourceId })
  })

  test('given a rate correction, reverses the original rate and records the replacement rate with exact controls', async () => {
    const f = await fixture('correction-rate')
    const result = await f.correct(f.input(20000, 'DE_REDUCED'))
    const rows = await prisma.vatPostingRecord.findMany({ where: { ownerId: f.ownerId }, include: { journalLine: true } })
    expect(rows.find(row => row.journalLine?.journalEntryId === result.reversal.id)).toMatchObject({ rateBasisPoints: 1900, taxCents: -1900, ruleId: 'DE_STANDARD', ruleVersion: 1 })
    expect(rows.find(row => row.journalLine?.journalEntryId === result.replacement.id)).toMatchObject({ rateBasisPoints: 700, taxCents: 1400, ruleId: 'DE_REDUCED', ruleVersion: 1, documentId: f.documentId })
    await expectReconciled(f.ownerId, 1400)
    const controls = await prisma.journalLine.findMany({ where: { journalEntry: { ownerId: f.ownerId }, account: { number: 1776 } } })
    expect(controls.reduce((sum, line) => sum + line.creditCents - line.debitCents, 0)).toBe(0)
  })

  test('given a synthetic rule-version transition, keeps the original version while calculating the replacement version', async () => {
    const f = await fixture('correction-rule-version')
    const { VatRuleBook } = await import('@/core/vatEngine')
    const resolveRule = VatRuleBook.prototype.at
    // Simulate a future rule-book release without changing production tax rules.
    const ruleLookup = vi.spyOn(VatRuleBook.prototype, 'at').mockImplementation(function (this: InstanceType<typeof VatRuleBook>, id, taxPoint) {
      const rule = resolveRule.call(this, id, taxPoint)
      return id === 'DE_STANDARD' && taxPoint >= '2026-09-01'
        ? { ...rule, version: 2, rateBasisPoints: 700, outputAccount: '1771', inputAccount: '1571', reason: 'Synthetic version transition' }
        : rule
    })
    try {
      const replacement = f.input(20000, 'DE_REDUCED', '2026-09-05')
      replacement.lines[1].vat!.ruleId = 'DE_STANDARD'
      const result = await f.correct(replacement)
      const rows = await prisma.vatPostingRecord.findMany({ where: { ownerId: f.ownerId }, include: { journalLine: true } })
      expect(rows.find(row => row.journalLine?.journalEntryId === result.reversal.id)).toMatchObject({ ruleVersion: 1, rateBasisPoints: 1900, taxCents: -1900 })
      expect(rows.find(row => row.journalLine?.journalEntryId === result.replacement.id)).toMatchObject({ ruleVersion: 2, rateBasisPoints: 700, taxCents: 1400 })
      await expectReconciled(f.ownerId, 0, '2026-08')
      await expectReconciled(f.ownerId, 1400, '2026-09')
      const committed = await snapshot(f.ownerId)
      await f.correct(replacement)
      expect(await snapshot(f.ownerId)).toEqual(committed)
    } finally { ruleLookup.mockRestore() }
  })

  test.each(['2026-09-05', '2027-01-05'])('given a replacement dated %s, retains the original tax point and reconciles each period', async date => {
    const f = await fixture(`correction-period-${date}`)
    if (date.startsWith('2027')) await prisma.fiscalYear.create({ data: { ownerId: f.ownerId, year: 2027, startsAt: new Date('2027-01-01'), endsAt: new Date('2027-12-31T23:59:59.999Z') } })
    await prisma.fiscalYear.update({ where: { id: f.original.fiscalYearId }, data: { status: 'REOPENED' } })
    const result = await f.correct(f.input(20000, 'DE_REDUCED', date))
    await expectReconciled(f.ownerId, 0, '2026-08')
    await expectReconciled(f.ownerId, 1400, date.slice(0, 7))
    await expectReconciled(f.ownerId, 1400)
    const rows = await prisma.vatPostingRecord.findMany({ where: { ownerId: f.ownerId }, include: { journalLine: true } })
    expect(rows.find(row => row.journalLine?.journalEntryId === result.reversal.id)?.taxPoint).toEqual(new Date('2026-08-04'))
    expect(rows.find(row => row.journalLine?.journalEntryId === result.replacement.id)?.taxPoint).toEqual(new Date(date))
  })

  test('given concurrent and later identical retries, returns the same pair without new evidence or audit events', async () => {
    const f = await fixture('correction-retry')
    const [first, concurrent] = await Promise.all([f.correct(), f.correct()])
    expect(concurrent.reversal.id).toBe(first.reversal.id)
    expect(concurrent.replacement.id).toBe(first.replacement.id)
    const committed = await snapshot(f.ownerId)
    const reordered = f.input(20000)
    reordered.lines.reverse()
    const retried = await f.correct(reordered)
    expect(retried.replacement.id).toBe(first.replacement.id)
    expect(await snapshot(f.ownerId)).toEqual(committed)
  })

  test.each(['mode', 'direction', 'ruleId', 'omitted'] as const)('given a retry changing only VAT %s, rejects the conflicting semantics', async field => {
    const f = await fixture(`correction-fingerprint-${field}`)
    await f.correct()
    const before = await snapshot(f.ownerId)
    const changed = f.input(20000)
    if (field === 'omitted') delete changed.lines[1].vat
    else Object.assign(changed.lines[1].vat!, { [field]: field === 'mode' ? 'gross' : field === 'direction' ? 'purchase' : 'DE_DEPOSIT' })
    await expect(f.correct(changed)).rejects.toThrow(/widerspricht/)
    expect(await snapshot(f.ownerId)).toEqual(before)
  })

  test.each(['control', 'unknown-rule', 'missing-vat', 'bare-tax-code', 'gross-base', 'wrong-direction', 'extra-control'] as const)('given invalid replacement VAT (%s), rolls back all changes and permits a valid retry', async invalid => {
    const f = await fixture(`correction-invalid-${invalid}`)
    const before = await snapshot(f.ownerId)
    const replacement = f.input(20000)
    if (invalid === 'control') { replacement.lines[0].debitCents -= 100; replacement.lines[2].creditCents -= 100 }
    if (invalid === 'unknown-rule') replacement.lines[1].vat!.ruleId = 'UNKNOWN'
    if (invalid === 'missing-vat') delete replacement.lines[1].vat
    if (invalid === 'bare-tax-code') { delete replacement.lines[1].vat; Object.assign(replacement.lines[1], { taxCode: 'DE_STANDARD' }) }
    if (invalid === 'gross-base') Object.assign(replacement.lines[1].vat!, { mode: 'gross' })
    if (invalid === 'wrong-direction') Object.assign(replacement.lines[1].vat!, { direction: 'purchase' })
    if (invalid === 'extra-control') { replacement.lines[0].debitCents += 100; replacement.lines.push({ accountId: f.account(1771), debitCents: 0, creditCents: 100 }) }
    await expect(f.correct(replacement)).rejects.toThrow()
    expect(await snapshot(f.ownerId)).toEqual(before)
    await f.correct()
    await expectReconciled(f.ownerId, 3800)
  })

  test('given an audit persistence failure, rolls back entries, VAT, reversal reservations and audit head', async () => {
    const f = await fixture('correction-audit-failure')
    const before = await snapshot(f.ownerId)
    await prisma.$executeRawUnsafe("CREATE TRIGGER reject_correction_audit BEFORE INSERT ON AuditEvent WHEN NEW.action = 'JOURNAL_ENTRY_CORRECTED' BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END")
    try { await expect(f.correct()).rejects.toThrow() }
    finally { await prisma.$executeRawUnsafe('DROP TRIGGER reject_correction_audit') }
    expect(await snapshot(f.ownerId)).toEqual(before)
    await f.correct()
    await expectReconciled(f.ownerId, 3800)
  })

  test('given a legacy taxable entry without linked VAT evidence, rejects the correction without changing it', async () => {
    const f = await fixture('correction-legacy')
    const legacyInput = f.input()
    delete legacyInput.lines[1].vat
    Object.assign(legacyInput.lines[1], { taxCode: 'DE_STANDARD' })
    const legacy = await ledger.postJournalEntry(f.ownerId, legacyInput)
    const before = await snapshot(f.ownerId)
    await expect(runtime.correctPostedEntry(f.ownerId, 'actor', legacy.id, { reason: 'Correct legacy', replacement: f.input(20000) })).rejects.toThrow(/Umsatzsteuernachweis/)
    expect(await snapshot(f.ownerId)).toEqual(before)
  })

  test('given a taxable purchase, reverses and replaces deductible input VAT with its original provenance', async () => {
    const f = await fixture('correction-purchase')
    const purchase = (net: number) => ({ ...f.input(net), documentNumber: 'purchase-correction', lines: [
      { accountId: f.account(4930), debitCents: net, creditCents: 0, vat: { ruleId: 'DE_STANDARD', mode: 'net', direction: 'purchase' } },
      { accountId: f.account(1576), debitCents: net * 0.19, creditCents: 0 },
      { accountId: f.account(1600), debitCents: 0, creditCents: net * 1.19 },
    ] })
    const original = await ledger.postJournalEntry(f.ownerId, purchase(10000))
    const result = await runtime.correctPostedEntry(f.ownerId, 'actor', original.id, { reason: 'Correct purchase', replacement: purchase(20000) })
    const reversal = await prisma.vatPostingRecord.findFirstOrThrow({ where: { journalLine: { journalEntryId: result.reversal.id } } })
    expect(reversal).toMatchObject({ inputTaxCents: -1900, deductibleTaxCents: -1900, outputTaxCents: 0, documentId: f.documentId })
    await expectReconciled(f.ownerId, 3800, undefined, 'input')
  })
})
