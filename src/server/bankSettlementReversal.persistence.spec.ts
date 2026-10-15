import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import type { OpenItem } from '@/generated/prisma/client'

vi.mock('server-only', () => ({}))

const directory = mkdtempSync(join(tmpdir(), 'accounting-payment-reversal-'))
const databasePath = join(directory, 'test.db').replace(/\\/g, '/')
let banking: typeof import('./bankingRepository')
let commercial: typeof import('./commercialAccountingRepository')
let prisma: typeof import('./persistence/client').prisma

beforeAll(async () => {
  const database = new DatabaseSync(databasePath)
  for (const name of readdirSync(resolve('prisma/migrations')).sort()) {
    if (name !== 'migration_lock.toml') database.exec(readFileSync(resolve('prisma/migrations', name, 'migration.sql'), 'utf8'))
  }
  database.exec('PRAGMA journal_mode=WAL')
  database.close()
  vi.stubEnv('DATABASE_URL', `file:${databasePath}`)
  vi.stubEnv('DOCUMENT_STORAGE_DRIVER', 'fs')
  vi.stubEnv('DOCUMENT_STORAGE_ROOT', join(directory, 'documents'))
  banking = await import('./bankingRepository')
  commercial = await import('./commercialAccountingRepository')
  prisma = (await import('./persistence/client')).prisma
})

afterAll(async () => {
  await prisma?.$disconnect()
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

async function matchedPayment(amountCents = 25_000, invoiceAmounts = [11_900]) {
  const ownerId = randomUUID()
  const actorId = 'synthetic-test-actor'
  const fiscalYear = await prisma.fiscalYear.create({ data: { ownerId, year: 2026, startsAt: new Date('2026-01-01'), endsAt: new Date('2026-12-31') } })
  await prisma.ledgerProfile.create({ data: { ownerId, chart: 'SKR03', accountLength: 4 } })
  const bankLedger = await prisma.ledgerAccount.create({ data: { ownerId, number: 1200, name: 'Synthetic bank', category: 'ASSET' } })
  await prisma.ledgerAccount.create({ data: { ownerId, number: 1400, name: 'Receivables', category: 'ASSET' } })
  const partner = await prisma.businessPartner.create({ data: { ownerId, partnerNumber: 'TEST-1', role: 'CUSTOMER', name: 'Synthetic customer' } })
  const evidence = await prisma.documentRecord.create({ data: { id: randomUUID(), ownerId, payload: '{}' } })
  const items: OpenItem[] = []
  for (const [index, cents] of [...invoiceAmounts, amountCents].entries()) {
    const document = await prisma.commercialDocument.create({ data: {
      ownerId, businessPartnerId: partner.id, evidenceDocumentId: evidence.id, direction: 'RECEIVABLE', kind: 'INVOICE', status: 'FINAL',
      documentNumber: `TEST-${index}`, documentIdentityKey: `${ownerId}:${index}`, issueDate: new Date('2026-08-01'), serviceDate: new Date('2026-08-01'), dueDate: new Date('2026-08-15'),
      description: 'Synthetic invoice', currency: 'EUR', netAmountCents: cents, taxAmountCents: 0, grossAmountCents: cents, payableAmountCents: cents, counterpartySnapshot: '{}',
    } })
    items.push(await prisma.openItem.create({ data: { ownerId, commercialDocumentId: document.id, side: 'DEBIT', currency: 'EUR', originalAmountCents: cents } }))
  }
  const account = await banking.createBankAccount(ownerId, actorId, { name: 'Synthetic bank', iban: 'BE55967298399244', ledgerAccountId: bankLedger.id })
  const amount = (amountCents / 100).toFixed(2)
  await banking.importCamtStatement(ownerId, actorId, account.id, Buffer.from(`<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt><Stmt><Id>synthetic-statement</Id><FrToDt><FrDtTm>2026-08-01T00:00:00Z</FrDtTm><ToDtTm>2026-08-31T23:59:59Z</ToDtTm></FrToDt><Acct><Id><IBAN>BE55967298399244</IBAN></Id></Acct><Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">0.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal><Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">${amount}</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal><Ntry><Amt Ccy="EUR">${amount}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>2026-08-04</Dt></BookgDt><NtryRef>synthetic-receipt</NtryRef></Ntry></Stmt></BkToCstmrStmt></Document>`))
  const bankTransaction = await prisma.bankTransaction.findFirstOrThrow({ where: { ownerId } })
  const allocations = invoiceAmounts.map((amountCents, index) => ({ openItemId: items[index].id, amountCents }))
  const input = { allocations, reason: 'Synthetic confirmed receipt' }
  const requestKey = randomUUID()
  const match = await banking.confirmBankTransactionMatch(ownerId, actorId, bankTransaction.id, requestKey, input)
  return { ownerId, actorId, fiscalYear, bankLedger, items, bankTransaction, match, requestKey, input }
}

type Payment = Awaited<ReturnType<typeof matchedPayment>>
const reversalInput = { effectiveDate: '2026-08-06', reason: 'Synthetic mistaken bank match' }
function reverse(payment: Payment, requestKey = randomUUID()) {
  return banking.reverseBankTransactionMatch(payment.ownerId, payment.actorId, payment.match.id, requestKey, reversalInput)
}
function creditInput(payment: Payment, amountCents = 100) {
  return { openItemId: payment.items.at(-1)!.id, settlementId: payment.match.settlementId, amountCents, effectiveDate: '2026-08-05', reason: 'Apply synthetic remaining credit' }
}
function rawApply(database: DatabaseSync, payment: Payment, amountCents = 100) {
  return database.prepare(`INSERT INTO SettlementAllocation
    (id, ownerId, openItemId, settlementId, journalEntryId, kind, amountCents, requestKey, requestHash, effectiveDate, createdBy)
    VALUES (?, ?, ?, ?, ?, 'APPLY', ?, ?, ?, '2026-08-07', 'synthetic-test-actor')`)
    .run(randomUUID(), payment.ownerId, payment.items.at(-1)!.id, payment.match.settlementId, payment.match.journalEntryId, amountCents, randomUUID(), 'a'.repeat(64))
}
async function expectReopened(payment: Payment) {
  const items = await prisma.openItem.findMany({ where: { ownerId: payment.ownerId } })
  for (const item of items) expect(item).toMatchObject({ allocatedAmountCents: 0, status: 'OPEN' })
  const lines = await prisma.journalLine.findMany({ where: { accountId: payment.bankLedger.id } })
  expect(lines.reduce((sum, line) => sum + line.debitCents - line.creditCents, 0)).toBe(0)
  await expect(prisma.settlementAllocation.count({ where: { ownerId: payment.ownerId, kind: 'APPLY', reversedBy: { none: {} } } })).resolves.toBe(0)
}

function rawReversePrimaryAllocation(database: DatabaseSync, payment: Payment, linkJournal = true) {
  const journalEntryId = randomUUID()
  const allocationId = randomUUID()
  database.prepare(`INSERT INTO JournalEntry (id, ownerId, fiscalYearId, sequenceNumber, bookingDate, documentNumber, description, reversalOfId)
    VALUES (?, ?, ?, 2, '2026-08-06', 'TEST-REVERSAL', 'Synthetic reversal', ?)`)
    .run(journalEntryId, payment.ownerId, payment.fiscalYear.id, linkJournal ? payment.match.journalEntryId : null)
  database.prepare(`INSERT INTO SettlementAllocation
    (id, ownerId, openItemId, settlementId, journalEntryId, kind, amountCents, requestKey, requestHash, reversesAllocationId, effectiveDate, createdBy)
    VALUES (?, ?, ?, ?, ?, 'REVERSAL', ?, ?, ?, ?, '2026-08-06', ?)`)
    .run(allocationId, payment.ownerId, payment.match.openItemId, payment.match.settlementId, journalEntryId, -payment.match.allocation.amountCents, randomUUID(), 'b'.repeat(64), payment.match.allocationId, payment.actorId)
  return { journalEntryId, allocationId }
}
function rawReverseMatch(database: DatabaseSync, payment: Payment, linkJournal = true) {
  const { journalEntryId, allocationId } = rawReversePrimaryAllocation(database, payment, linkJournal)
  database.prepare(`INSERT INTO BankTransactionMatch
    (id, ownerId, bankTransactionId, openItemId, settlementId, journalEntryId, allocationId, kind, amountCents, reversesMatchId, requestKey, requestHash, effectiveDate, createdBy)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'REVERSAL', ?, ?, ?, ?, '2026-08-06', ?)`)
    .run(randomUUID(), payment.ownerId, payment.bankTransaction.id, payment.match.openItemId, payment.match.settlementId, journalEntryId, allocationId, -payment.match.amountCents, payment.match.id, randomUUID(), 'c'.repeat(64), payment.actorId)
}

describe('terminal bank payment reversal', () => {
  test.each([
    { kind: 'exact', amount: 11_900, invoices: [11_900] },
    { kind: 'split', amount: 11_900, invoices: [6_000, 5_900] },
    { kind: 'overpayment', amount: 25_000, invoices: [11_900] },
  ])('Given a reversed $kind match, when its payment is reused, then service and SQL reject it while a new rematch succeeds', async ({ amount, invoices }) => {
    const payment = await matchedPayment(amount, invoices)
    const reversalKey = randomUUID()
    const reversal = await reverse(payment, reversalKey)
    await expect(commercial.allocateSettlement(payment.ownerId, payment.actorId, randomUUID(), { ...creditInput(payment), ...payment.input.allocations[0] })).rejects.toThrow(/payment.*reversed/i)
    const database = new DatabaseSync(databasePath)
    try { expect(() => rawApply(database, payment)).toThrow(/payment.*reversed/i) } finally { database.close() }
    await expectReopened(payment)
    expect((await reverse(payment, reversalKey)).id).toBe(reversal.id)
    expect((await banking.confirmBankTransactionMatch(payment.ownerId, payment.actorId, payment.bankTransaction.id, payment.requestKey, payment.input)).id).toBe(payment.match.id)
    const rematch = await banking.confirmBankTransactionMatch(payment.ownerId, payment.actorId, payment.bankTransaction.id, randomUUID(), payment.input)
    expect(rematch.settlementId).not.toBe(payment.match.settlementId)
    for (const allocation of payment.input.allocations) {
      await expect(prisma.openItem.findUniqueOrThrow({ where: { id: allocation.openItemId } })).resolves.toMatchObject({ status: 'SETTLED', allocatedAmountCents: allocation.amountCents })
    }
  })

  test('Given previously applied remaining credit, when the bank match is reversed, then replay returns history without reapplying it', async () => {
    const payment = await matchedPayment()
    const key = randomUUID()
    const input = creditInput(payment, 13_100)
    const allocation = await commercial.allocateSettlement(payment.ownerId, payment.actorId, key, input)
    await reverse(payment)
    expect((await commercial.allocateSettlement(payment.ownerId, payment.actorId, key, input)).id).toBe(allocation.id)
    await expect(commercial.allocateSettlement(payment.ownerId, payment.actorId, key, { ...input, amountCents: 100 })).rejects.toThrow(/different facts/)
    await expect(commercial.allocateSettlement(payment.ownerId, payment.actorId, randomUUID(), input)).rejects.toThrow(/payment.*reversed/i)
    await expectReopened(payment)
  })

  test('Given allocation-only undo, when credit is allocated again, then the unreversed payment remains available', async () => {
    const payment = await matchedPayment()
    const input = creditInput(payment)
    const allocation = await commercial.allocateSettlement(payment.ownerId, payment.actorId, randomUUID(), input)
    const journal = await prisma.journalEntry.create({ data: { ownerId: payment.ownerId, fiscalYearId: payment.fiscalYear.id, sequenceNumber: 2, bookingDate: new Date('2026-08-05'), documentNumber: 'ALLOCATION-UNDO', description: 'Allocation-only undo' } })
    const undoInput = { ...input, amountCents: -input.amountCents, journalEntryId: journal.id, reversesAllocationId: allocation.id }
    const undoKey = randomUUID()
    const undo = await commercial.allocateSettlement(payment.ownerId, payment.actorId, undoKey, undoInput)
    expect((await commercial.allocateSettlement(payment.ownerId, payment.actorId, undoKey, undoInput)).id).toBe(undo.id)
    const reapplied = await commercial.allocateSettlement(payment.ownerId, payment.actorId, randomUUID(), input)
    expect(reapplied.id).not.toBe(allocation.id)
    await reverse(payment)
    await expectReopened(payment)
  })

  test.each(['allocation', 'reversal'] as const)('Given concurrent allocation and reversal with %s requested first, when both finish, then no reversed payment remains allocated', async first => {
    const payment = await matchedPayment()
    const operations = {
      allocation: () => commercial.allocateSettlement(payment.ownerId, payment.actorId, randomUUID(), creditInput(payment)),
      reversal: () => reverse(payment),
    }
    const results = await Promise.allSettled([operations[first](), operations[first === 'allocation' ? 'reversal' : 'allocation']()])
    const reversalResult = results[first === 'reversal' ? 0 : 1]
    // A competing SQLite writer may abort; a retry must still see and reverse all committed allocations.
    if (reversalResult.status === 'rejected') await reverse(payment)
    await expectReopened(payment)
    await expect(commercial.allocateSettlement(payment.ownerId, payment.actorId, randomUUID(), creditInput(payment))).rejects.toThrow(/payment.*reversed/i)
  })

  test('Given an independent SQL reader with a stale available balance, when reversal commits, then the stale write aborts and its retry rejects the reversed payment', async () => {
    const payment = await matchedPayment()
    const stale = new DatabaseSync(databasePath)
    try {
      stale.exec('PRAGMA busy_timeout=0; BEGIN')
      expect(stale.prepare('SELECT allocatedAmountCents FROM PaymentSettlement WHERE id=?').get(payment.match.settlementId)).toEqual({ allocatedAmountCents: 11_900 })
      await reverse(payment)
      expect(() => rawApply(stale, payment)).toThrow(/locked|busy/i)
      stale.exec('ROLLBACK')
      expect(() => rawApply(stale, payment)).toThrow(/payment.*reversed/i)
    } finally {
      if (stale.isTransaction) stale.exec('ROLLBACK')
      stale.close()
    }
    await expectReopened(payment)
  })

  test('Given extra credit allocated before reversal, when a direct writer reverses only the primary allocation, then persistence rejects the incomplete reversal atomically', async () => {
    const payment = await matchedPayment()
    await commercial.allocateSettlement(payment.ownerId, payment.actorId, randomUUID(), creditInput(payment))
    const database = new DatabaseSync(databasePath)
    try {
      database.exec('BEGIN')
      expect(() => rawReverseMatch(database, payment)).toThrow(/active.*allocations/i)
    } finally {
      if (database.isTransaction) database.exec('ROLLBACK')
      database.close()
    }
    await expect(prisma.journalEntry.count({ where: { ownerId: payment.ownerId } })).resolves.toBe(1)
    await expect(prisma.settlementAllocation.count({ where: { ownerId: payment.ownerId, kind: 'REVERSAL' } })).resolves.toBe(0)
    await reverse(payment)
    await expectReopened(payment)
  })

  test('Given a posted payment reversal before the match reversal is appended, when an allocation is inserted in that transaction, then persistence already rejects it', async () => {
    const payment = await matchedPayment()
    const database = new DatabaseSync(databasePath)
    try {
      database.exec('BEGIN')
      rawReversePrimaryAllocation(database, payment)
      expect(() => rawApply(database, payment)).toThrow(/payment.*reversed/i)
    } finally {
      if (database.isTransaction) database.exec('ROLLBACK')
      database.close()
    }
    await expect(prisma.journalEntry.count({ where: { ownerId: payment.ownerId } })).resolves.toBe(1)
  })

  test('Given a historical bank reversal without a journal reversal link, when credit is reused, then immutable match history still makes the payment unavailable', async () => {
    const payment = await matchedPayment()
    const database = new DatabaseSync(databasePath)
    try {
      database.exec('BEGIN')
      rawReverseMatch(database, payment, false)
      database.exec('COMMIT')
      expect(() => rawApply(database, payment)).toThrow(/payment.*reversed/i)
    } finally {
      if (database.isTransaction) database.exec('ROLLBACK')
      database.close()
    }
    await expect(commercial.allocateSettlement(payment.ownerId, payment.actorId, randomUUID(), creditInput(payment))).rejects.toThrow(/payment.*reversed/i)
  })
})
