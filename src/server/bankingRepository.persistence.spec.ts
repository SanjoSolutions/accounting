import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const directory = mkdtempSync(join(tmpdir(), 'accounting-banking-repository-'))
const databasePath = join(directory, 'test.db').replace(/\\/g, '/')
let api: typeof import('./bankingRepository')
let prisma: typeof import('@/server/persistence/client').prisma

function camt(statementId = 'stmt-1', reference = 'bank-ref-1', amount = '119.00', closing = '1119.00', remittance = 'Invoice RE-2026-0001') {
  return Buffer.from(`<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt><Stmt><Id>${statementId}</Id><FrToDt><FrDtTm>2026-08-01T00:00:00Z</FrDtTm><ToDtTm>2026-08-31T23:59:59Z</ToDtTm></FrToDt><Acct><Id><IBAN>DE44500105175407324931</IBAN></Id></Acct><Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">1000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal><Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">${closing}</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal><Ntry><Amt Ccy="EUR">${amount}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>2026-08-04</Dt></BookgDt><NtryRef>${reference}</NtryRef><NtryDtls><TxDtls><Refs><AcctSvcrRef>${reference}</AcctSvcrRef></Refs><RltdPties><Dbtr><Nm>Musterkunde GmbH</Nm></Dbtr></RltdPties><RmtInf><Ustrd>${remittance}</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry></Stmt></BkToCstmrStmt></Document>`)
}

beforeAll(async () => {
  const database = new DatabaseSync(databasePath)
  for (const name of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort()) database.exec(readFileSync(resolve('prisma/migrations', name, 'migration.sql'), 'utf8'))
  database.close(); process.env.DATABASE_URL = `file:${databasePath}`
  api = await import('./bankingRepository'); prisma = (await import('@/server/persistence/client')).prisma
  await prisma.fiscalYear.createMany({ data: [{ id: 'fy-a', ownerId: 'tenant-a', year: 2026, startsAt: new Date('2026-01-01'), endsAt: new Date('2026-12-31') }, { id: 'fy-b', ownerId: 'tenant-b', year: 2026, startsAt: new Date('2026-01-01'), endsAt: new Date('2026-12-31') }] })
  await prisma.ledgerProfile.createMany({ data: [{ ownerId: 'tenant-a', chart: 'SKR03', accountLength: 4 }, { ownerId: 'tenant-b', chart: 'SKR03', accountLength: 4 }] })
  await prisma.ledgerAccount.createMany({ data: [{ id: 'bank-ledger-a', ownerId: 'tenant-a', number: 1200, name: 'Bank', category: 'ASSET' }, { id: 'receivable-a', ownerId: 'tenant-a', number: 1400, name: 'Receivables', category: 'ASSET' }, { id: 'bank-ledger-b', ownerId: 'tenant-b', number: 1200, name: 'Bank', category: 'ASSET' }] })
  await prisma.businessPartner.create({ data: { id: 'partner-a', ownerId: 'tenant-a', partnerNumber: 'K-1', role: 'CUSTOMER', name: 'Musterkunde GmbH' } })
  await prisma.documentRecord.create({ data: { id: 'evidence-a', ownerId: 'tenant-a', payload: '{}' } })
  await prisma.commercialDocument.create({ data: { id: 'invoice-a', ownerId: 'tenant-a', businessPartnerId: 'partner-a', evidenceDocumentId: 'evidence-a', direction: 'RECEIVABLE', kind: 'INVOICE', status: 'FINAL', documentNumber: 'RE-2026-0001', documentIdentityKey: 'invoice-identity-a', issueDate: new Date('2026-08-01'), serviceDate: new Date('2026-08-01'), dueDate: new Date('2026-08-15'), description: 'Consulting', currency: 'EUR', netAmountCents: 10_000, taxAmountCents: 1_900, grossAmountCents: 11_900, payableAmountCents: 11_900, counterpartySnapshot: '{}' } })
  await prisma.openItem.create({ data: { id: 'open-a', ownerId: 'tenant-a', commercialDocumentId: 'invoice-a', side: 'DEBIT', currency: 'EUR', originalAmountCents: 11_900 } })
})

afterAll(async () => { await prisma.$disconnect(); delete process.env.DATABASE_URL; rmSync(directory, { recursive: true, force: true }) })

describe('persistent CAMT review repository', () => {
  let accountId = ''
  it('Given a tenant ledger account, when a German bank account is configured, then its compound ownership is durable', async () => {
    const account = await api.createBankAccount('tenant-a', 'user-a', { name: 'Hausbank', iban: 'DE44 5001 0517 5407 3249 31', ledgerAccountId: 'bank-ledger-a' })
    accountId = account.id
    expect(account).toMatchObject({ ownerId: 'tenant-a', iban: 'DE44500105175407324931', currency: 'EUR' })
    await expect(api.createBankAccount('tenant-a', 'user-a', { name: 'Cross tenant', iban: 'DE12500105170648489890', ledgerAccountId: 'bank-ledger-b' })).rejects.toThrow(/does not belong/)
  })

  it('Given a booked statement, when imported and retried, then original bytes persist and no transaction is duplicated', async () => {
    const original = camt(); const first = await api.importCamtStatement('tenant-a', 'user-a', accountId, original); const replay = await api.importCamtStatement('tenant-a', 'user-a', accountId, original)
    expect(first).toMatchObject({ imported: 1, skipped: 0 }); expect(replay).toMatchObject({ imported: 0, skipped: 1 })
    await expect(prisma.bankTransaction.count({ where: { ownerId: 'tenant-a' } })).resolves.toBe(1)
    const stored = await prisma.bankStatement.findUniqueOrThrow({ where: { id: first.statement.id } })
    expect(Buffer.from(stored.originalXml).equals(original)).toBe(true)
  })

  it('Given an overlapping statement containing an existing bank reference, when imported, then the transaction is skipped', async () => {
    const result = await api.importCamtStatement('tenant-a', 'user-a', accountId, camt('stmt-overlap'))
    expect(result).toMatchObject({ imported: 0, skipped: 1 })
    await expect(prisma.bankStatement.count({ where: { ownerId: 'tenant-a' } })).resolves.toBe(2)
    await expect(prisma.bankTransaction.count({ where: { ownerId: 'tenant-a' } })).resolves.toBe(1)
  })

  it('Given an unmatched receipt and an exact invoice reference, when review data is loaded, then one explicit suggestion is returned without posting', async () => {
    const rows = await api.listBankTransactionsWithSuggestions('tenant-a')
    expect(rows[0]).toMatchObject({ reviewState: 'UNMATCHED', suggestions: [{ openItemId: 'open-a', documentNumber: 'RE-2026-0001', amountCents: 11_900 }] })
    await expect(prisma.paymentSettlement.count()).resolves.toBe(0)
    await expect(api.listBankTransactionsWithSuggestions('tenant-b')).resolves.toEqual([])
  })

  it('Given an explicitly confirmed exact suggestion, when concurrent confirmation is attempted, then one atomic journal, settlement, allocation, and match settles the item', async () => {
    const transaction = await prisma.bankTransaction.findFirstOrThrow({ where: { ownerId: 'tenant-a' } })
    const results = await Promise.allSettled([
      api.confirmBankTransactionMatch('tenant-a', 'user-a', transaction.id, 'bank-match-request-0001', { openItemId: 'open-a', reason: 'Confirmed exact receipt' }),
      api.confirmBankTransactionMatch('tenant-a', 'user-a', transaction.id, 'bank-match-request-0002', { openItemId: 'open-a', reason: 'Concurrent duplicate' }),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    const match = (results.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof api.confirmBankTransactionMatch>>>).value
    const replay = await api.confirmBankTransactionMatch('tenant-a', 'user-a', transaction.id, match.requestKey, { openItemId: 'open-a', reason: 'Ignored for idempotent fact hash' })
    expect(replay.id).toBe(match.id)
    expect(match.journalEntry.lines.map(line => ({ number: line.account.number, debit: line.debitCents, credit: line.creditCents }))).toEqual([{ number: 1200, debit: 11_900, credit: 0 }, { number: 1400, debit: 0, credit: 11_900 }])
    await expect(prisma.openItem.findUnique({ where: { id: 'open-a' } })).resolves.toMatchObject({ allocatedAmountCents: 11_900, status: 'SETTLED' })
    await expect(prisma.paymentSettlement.count({ where: { ownerId: 'tenant-a' } })).resolves.toBe(1)
    await expect(prisma.bankTransactionMatch.count({ where: { ownerId: 'tenant-a', kind: 'APPLY' } })).resolves.toBe(1)
    expect((await api.listBankTransactionsWithSuggestions('tenant-a'))[0]).toMatchObject({ reviewState: 'MATCHED', activeMatch: { id: match.id }, suggestions: [] })
  })

  it('Given an active bank match, when reversal is confirmed and retried, then exact opposite journal and allocation reopen the item append-only', async () => {
    const match = await prisma.bankTransactionMatch.findFirstOrThrow({ where: { ownerId: 'tenant-a', kind: 'APPLY' }, include: { journalEntry: { include: { lines: true } } } })
    const reversal = await api.reverseBankTransactionMatch('tenant-a', 'user-a', match.id, 'bank-reversal-request-01', { effectiveDate: '2026-08-04', reason: 'User reversed mistaken reconciliation' })
    const replay = await api.reverseBankTransactionMatch('tenant-a', 'user-a', match.id, 'bank-reversal-request-01', { effectiveDate: '2026-08-04', reason: 'Idempotent replay' })
    expect(replay.id).toBe(reversal.id); expect(reversal.amountCents).toBe(-11_900)
    expect(reversal.journalEntry.lines.map(line => ({ number: line.account.number, debit: line.debitCents, credit: line.creditCents }))).toEqual([{ number: 1200, debit: 0, credit: 11_900 }, { number: 1400, debit: 11_900, credit: 0 }])
    await expect(prisma.openItem.findUnique({ where: { id: 'open-a' } })).resolves.toMatchObject({ allocatedAmountCents: 0, status: 'OPEN' })
    await expect(prisma.settlementAllocation.count({ where: { ownerId: 'tenant-a' } })).resolves.toBe(2)
    await expect(prisma.bankTransactionMatch.count({ where: { ownerId: 'tenant-a' } })).resolves.toBe(2)
    expect((await api.listBankTransactionsWithSuggestions('tenant-a'))[0]).toMatchObject({ reviewState: 'REVERSED', activeMatch: null, suggestions: [{ openItemId: 'open-a' }] })
  })

  it('Given a receipt below the open remainder, when it is reviewed and confirmed, then it posts atomically as a durable partial allocation', async () => {
    await api.importCamtStatement('tenant-a', 'user-a', accountId, camt('stmt-partial', 'bank-ref-partial', '59.50', '1059.50'))
    const rows = await api.listBankTransactionsWithSuggestions('tenant-a')
    const partial = rows.find(row => row.bankReference === 'bank-ref-partial')!
    expect(partial).toMatchObject({ reviewState: 'UNMATCHED', suggestions: [{ openItemId: 'open-a', amountCents: 5_950, reason: expect.stringMatching(/Partial amount/) }] })
    const match = await api.confirmBankTransactionMatch('tenant-a', 'user-a', partial.id, 'bank-match-partial-0001', { openItemId: 'open-a', reason: 'Confirmed partial receipt' })
    expect(match.journalEntry.lines.map(line => ({ number: line.account.number, debit: line.debitCents, credit: line.creditCents }))).toEqual([{ number: 1200, debit: 5_950, credit: 0 }, { number: 1400, debit: 0, credit: 5_950 }])
    await expect(prisma.openItem.findUnique({ where: { id: 'open-a' } })).resolves.toMatchObject({ allocatedAmountCents: 5_950, status: 'PARTIAL' })
    const replay = await api.confirmBankTransactionMatch('tenant-a', 'user-a', partial.id, 'bank-match-partial-0001', { openItemId: 'open-a', reason: 'Safe replay' })
    expect(replay.id).toBe(match.id)
  })

  it('Given one receipt covering two invoices plus excess cents, when it is confirmed and the credit is later applied, then exact split allocations and the credit reverse append-only as one reconciliation', async () => {
    for (const suffix of ['2', '3', '4']) {
      const amount = suffix === '4' ? 5_000 : 11_900
      await prisma.commercialDocument.create({ data: { id: `invoice-${suffix}`, ownerId: 'tenant-a', businessPartnerId: 'partner-a', evidenceDocumentId: 'evidence-a', direction: 'RECEIVABLE', kind: 'INVOICE', status: 'FINAL', documentNumber: `RE-2026-000${suffix}`, documentIdentityKey: `invoice-identity-${suffix}`, issueDate: new Date('2026-08-01'), serviceDate: new Date('2026-08-01'), dueDate: new Date('2026-08-15'), description: 'Consulting', currency: 'EUR', netAmountCents: amount, taxAmountCents: 0, grossAmountCents: amount, payableAmountCents: amount, counterpartySnapshot: '{}' } })
      await prisma.openItem.create({ data: { id: `open-${suffix}`, ownerId: 'tenant-a', commercialDocumentId: `invoice-${suffix}`, side: 'DEBIT', currency: 'EUR', originalAmountCents: amount } })
    }
    await api.importCamtStatement('tenant-a', 'user-a', accountId, camt('stmt-split-overpay', 'bank-ref-split-overpay', '250.00', '1250.00', 'RE-2026-0002 and RE-2026-0003'))
    const bankTransaction = (await api.listBankTransactionsWithSuggestions('tenant-a')).find(row => row.bankReference === 'bank-ref-split-overpay')!
    expect(bankTransaction).toMatchObject({ reviewState: 'UNMATCHED', suggestedCreditCents: 1_200, suggestions: [{ openItemId: 'open-2', amountCents: 11_900 }, { openItemId: 'open-3', amountCents: 11_900 }] })
    await expect(api.confirmBankTransactionMatch('tenant-a', 'user-a', bankTransaction.id, 'bank-match-invalid-cents-01', { allocations: [{ openItemId: 'open-2', amountCents: 11_901 }, { openItemId: 'open-3', amountCents: 11_900 }], reason: 'Invalid cent split' })).rejects.toThrow(/exceeds the open remainder/)
    await prisma.businessPartner.create({ data: { id: 'partner-other', ownerId: 'tenant-a', partnerNumber: 'K-OTHER', role: 'CUSTOMER', name: 'Other customer' } })
    await prisma.commercialDocument.create({ data: { id: 'invoice-other', ownerId: 'tenant-a', businessPartnerId: 'partner-other', evidenceDocumentId: 'evidence-a', direction: 'RECEIVABLE', kind: 'INVOICE', status: 'FINAL', documentNumber: 'RE-OTHER', documentIdentityKey: 'invoice-identity-other', issueDate: new Date('2026-08-01'), serviceDate: new Date('2026-08-01'), dueDate: new Date('2026-08-15'), description: 'Other', currency: 'EUR', netAmountCents: 100, taxAmountCents: 0, grossAmountCents: 100, payableAmountCents: 100, counterpartySnapshot: '{}' } })
    await prisma.openItem.create({ data: { id: 'open-other', ownerId: 'tenant-a', commercialDocumentId: 'invoice-other', side: 'DEBIT', currency: 'EUR', originalAmountCents: 100 } })
    await expect(api.confirmBankTransactionMatch('tenant-a', 'user-a', bankTransaction.id, 'bank-match-cross-partner-01', { allocations: [{ openItemId: 'open-2', amountCents: 11_900 }, { openItemId: 'open-other', amountCents: 100 }], reason: 'Invalid cross-partner split' })).rejects.toThrow(/same business partner/)
    await expect(prisma.bankTransactionMatch.count({ where: { bankTransactionId: bankTransaction.id } })).resolves.toBe(0)

    const match = await api.confirmBankTransactionMatch('tenant-a', 'user-a', bankTransaction.id, 'bank-match-split-overpay-01', { allocations: bankTransaction.suggestions.map(item => ({ openItemId: item.openItemId, amountCents: item.amountCents })), reason: 'Confirmed split receipt and retained excess as customer credit' })
    await expect(api.confirmBankTransactionMatch('tenant-a', 'user-a', bankTransaction.id, 'bank-match-split-overpay-01', { allocations: [{ openItemId: 'open-2', amountCents: 11_899 }, { openItemId: 'open-3', amountCents: 11_900 }], reason: 'Conflicting replay' })).rejects.toThrow(/request key was already used with different facts/)
    expect(match.amountCents).toBe(25_000)
    expect(match.journalEntry.lines.map(line => ({ number: line.account.number, debit: line.debitCents, credit: line.creditCents }))).toEqual([{ number: 1200, debit: 25_000, credit: 0 }, { number: 1400, debit: 0, credit: 25_000 }])
    await expect(prisma.openItem.findMany({ where: { id: { in: ['open-2', 'open-3'] }, status: 'SETTLED' } })).resolves.toHaveLength(2)
    const settlement = await prisma.paymentSettlement.findUniqueOrThrow({ where: { id: match.settlementId } })
    expect(settlement).toMatchObject({ amountCents: 25_000, allocatedAmountCents: 23_800, status: 'PARTIAL' })
    expect((await api.listBankTransactionsWithSuggestions('tenant-a')).find(row => row.id === bankTransaction.id)).toMatchObject({ reviewState: 'MATCHED', activeMatch: { allocations: [{ documentNumber: 'RE-2026-0002', amountCents: 11_900 }, { documentNumber: 'RE-2026-0003', amountCents: 11_900 }], creditCents: 1_200 } })

    const commercial = await import('./commercialAccountingRepository')
    await commercial.allocateSettlement('tenant-a', 'user-a', 'apply-bank-credit-0001', { openItemId: 'open-4', settlementId: settlement.id, amountCents: 1_200, effectiveDate: '2026-08-05', reason: 'Applied retained customer credit to a later invoice' })
    await expect(prisma.paymentSettlement.findUnique({ where: { id: settlement.id } })).resolves.toMatchObject({ allocatedAmountCents: 25_000, status: 'ALLOCATED' })
    await expect(prisma.openItem.findUnique({ where: { id: 'open-4' } })).resolves.toMatchObject({ allocatedAmountCents: 1_200, status: 'PARTIAL' })

    const reversal = await api.reverseBankTransactionMatch('tenant-a', 'user-a', match.id, 'reverse-split-overpay-001', { effectiveDate: '2026-08-06', reason: 'Reverse the complete bank reconciliation including applied credit' })
    expect(reversal.amountCents).toBe(-25_000)
    await expect(prisma.settlementAllocation.count({ where: { settlementId: settlement.id } })).resolves.toBe(6)
    await expect(prisma.paymentSettlement.findUnique({ where: { id: settlement.id } })).resolves.toMatchObject({ allocatedAmountCents: 0, status: 'UNALLOCATED' })
    for (const id of ['open-2', 'open-3', 'open-4']) await expect(prisma.openItem.findUnique({ where: { id } })).resolves.toMatchObject({ allocatedAmountCents: 0, status: 'OPEN' })
  })
})
