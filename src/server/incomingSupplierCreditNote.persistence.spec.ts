import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PrismaClient } from '@/generated/prisma/client'
import type { StructuredInvoiceData } from '@/core/eInvoice'

vi.mock('server-only', () => ({}))
const directory = mkdtempSync(join(tmpdir(), 'incoming-supplier-credit-')); const databasePath = join(directory, 'test.db').replace(/\\/g, '/')
let prisma: typeof import('@/server/persistence/client').prisma
let posting: typeof import('./incomingInvoicePosting')
let creditApi: typeof import('./incomingSupplierCreditNote')
let commercial: typeof import('./commercialAccountingRepository')

const originalData: StructuredInvoiceData = { syntax: 'UBL', kind: 'invoice', invoiceNumber: 'ER-MIXED-1', issueDate: '2026-07-25', supplyDate: '2026-07-25', seller: { name: 'Supplier GmbH', street: 'A 1', city: 'Berlin', postalCode: '10115', countryCode: 'DE', vatId: 'DE123456789' }, buyer: { name: 'Buyer GmbH', street: 'B 2', city: 'Berlin', postalCode: '10115', countryCode: 'DE' }, lines: [{ description: 'Books', quantity: 1, unitCode: 'C62', netAmountCents: 10_000, taxRateBasisPoints: 700, taxCategoryCode: 'S' }, { description: 'Service', quantity: 1, unitCode: 'C62', netAmountCents: 10_000, taxRateBasisPoints: 1900, taxCategoryCode: 'S' }], netAmountCents: 20_000, taxAmountCents: 2_600, grossAmountCents: 22_600, currency: 'EUR' }

beforeAll(async () => {
  const db = new DatabaseSync(databasePath); const migrations = resolve(process.cwd(), 'prisma', 'migrations'); for (const name of readdirSync(migrations, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort()) db.exec(readFileSync(join(migrations, name, 'migration.sql'), 'utf8')); db.close()
  process.env.DATABASE_URL = `file:${databasePath}`; process.env.AUDIT_INTEGRITY_SECRET = 'incoming-credit-audit-secret-32-chars'
  prisma = (await import('@/server/persistence/client')).prisma; posting = await import('./incomingInvoicePosting'); creditApi = await import('./incomingSupplierCreditNote'); commercial = await import('./commercialAccountingRepository')
  await prisma.fiscalYear.createMany({ data: [{ id: 'fy-a', ownerId: 'tenant-a', year: 2026, startsAt: new Date('2026-01-01'), endsAt: new Date('2026-12-31') }, { id: 'fy-b', ownerId: 'tenant-b', year: 2026, startsAt: new Date('2026-01-01'), endsAt: new Date('2026-12-31') }] })
  await prisma.ledgerProfile.createMany({ data: [{ ownerId: 'tenant-a', chart: 'SKR03', accountLength: 4 }, { ownerId: 'tenant-b', chart: 'SKR03', accountLength: 4 }] })
  await prisma.ledgerAccount.createMany({ data: [{ id: 'expense-a', ownerId: 'tenant-a', number: 4930, name: 'Office expense', category: 'EXPENSE' }, { id: 'vat7-a', ownerId: 'tenant-a', number: 1571, name: 'Input VAT 7%', category: 'ASSET' }, { id: 'vat19-a', ownerId: 'tenant-a', number: 1576, name: 'Input VAT 19%', category: 'ASSET' }, { id: 'payable-a', ownerId: 'tenant-a', number: 1600, name: 'Trade payables', category: 'LIABILITY' }, { id: 'bank-a', ownerId: 'tenant-a', number: 1200, name: 'Bank', category: 'ASSET' }] })
  await prisma.documentRecord.create({ data: { id: 'original-evidence', ownerId: 'tenant-a', payload: '{}' } })
  await prisma.documentExtraction.create({ data: { ownerId: 'tenant-a', documentId: 'original-evidence', status: 'CONFIRMED', provider: 'structured-invoice', providerVersion: '1', inputHash: 'a'.repeat(64), extractedData: JSON.stringify({ supplierName: originalData.seller.name, invoiceNumber: originalData.invoiceNumber, issueDate: originalData.issueDate, netAmountCents: 20_000, taxAmountCents: 2_600, grossAmountCents: 22_600, currency: 'EUR', confidence: {}, provenance: 'STRUCTURED_INVOICE' }), reviewedBy: 'reviewer', reviewedAt: new Date('2026-08-01') } })
  await prisma.structuredInvoice.create({ data: { id: 'original-structured', ownerId: 'tenant-a', documentId: 'original-evidence', syntax: 'UBL', kind: 'invoice', direction: 'INCOMING', issuerKey: 'supplier-key', invoiceNumber: originalData.invoiceNumber, issueDate: new Date(originalData.issueDate), structuredHash: 'b'.repeat(64), originalMediaType: 'application/xml', structuredOriginal: Buffer.from('<Invoice/>'), data: JSON.stringify(originalData), provenance: '{}', renderedHtml: '<p>Invoice</p>' } })
})
afterAll(async () => { await prisma.$disconnect(); rmSync(directory, { recursive: true, force: true }) })

describe('incoming supplier credit-note persistence', () => {
  it('Given a partially paid posted payable, when concurrent duplicate posting and a later replay use identical facts, then one winner is returned idempotently without duplicate journals or corrections', async () => {
    const original = await posting.postConfirmedIncomingInvoice('tenant-a', 'user-a', 'original-evidence', { expenseAccountId: 'expense-a', dueDate: '2026-08-08', reason: 'Reviewed original' })
    const paymentJournal = await prisma.journalEntry.create({ data: { ownerId: 'tenant-a', fiscalYearId: 'fy-a', sequenceNumber: 2, bookingDate: new Date('2026-08-02'), documentNumber: 'PAY-1', description: 'Partial supplier payment', source: 'MANUAL', externalKey: 'payment-credit-test', lines: { create: [{ accountId: 'payable-a', debitCents: 5_000, creditCents: 0 }, { accountId: 'bank-a', debitCents: 0, creditCents: 5_000 }] } } })
    const settlement = await commercial.recordPaymentSettlement('tenant-a', 'user-a', { businessPartnerId: original.businessPartnerId, journalEntryId: paymentJournal.id, direction: 'DISBURSEMENT', currency: 'EUR', amountCents: 5_000, occurredOn: '2026-08-02', reason: 'Supplier paid' })
    await commercial.allocateSettlement('tenant-a', 'user-a', 'partial-payment-0001', { openItemId: original.openItem!.id, settlementId: settlement.id, amountCents: 5_000, effectiveDate: '2026-08-02', reason: 'Match payment' })
    const creditData: StructuredInvoiceData & { kind: 'credit-note'; correctedInvoiceNumber: string } = { ...originalData, kind: 'credit-note', invoiceNumber: 'GS-MIXED-1', correctedInvoiceNumber: originalData.invoiceNumber, issueDate: '2026-08-03', supplyDate: '2026-08-03' }
    await createCreditEvidence('credit-evidence', 'credit-structured', creditData)
    await expect(creditApi.postIncomingSupplierCredit('tenant-a', 'user-a', 'credit-evidence', { effectiveDate: '2026-07-24', requestKey: 'predated-credit-request-01', reason: 'Invalid predating attempt' })).rejects.toThrow(/cannot predate.*service.*posting.*VAT/i)
    const input = { effectiveDate: '2026-08-04', requestKey: 'supplier-credit-request-0001', reason: 'Reviewed exact supplier credit' }
    const [first, replay] = await Promise.all([creditApi.postIncomingSupplierCredit('tenant-a', 'user-a', 'credit-evidence', input), creditApi.postIncomingSupplierCredit('tenant-a', 'user-a', 'credit-evidence', input)])
    expect(replay.id).toBe(first.id)
    await expect(creditApi.postIncomingSupplierCredit('tenant-a', 'user-a', 'credit-evidence', input)).resolves.toMatchObject({ id: first.id })
    await expect(prisma.commercialDocument.count({ where: { ownerId: 'tenant-a', structuredInvoiceId: 'credit-structured' } })).resolves.toBe(1)
    await expect(prisma.journalEntry.count({ where: { ownerId: 'tenant-a', source: 'INCOMING_SUPPLIER_CREDIT_NOTE' } })).resolves.toBe(1)
    expect(first).toMatchObject({ direction: 'PAYABLE', kind: 'CREDIT_NOTE', status: 'POSTED', serviceDate: new Date('2026-08-04'), openItem: { side: 'DEBIT', originalAmountCents: 22_600, allocatedAmountCents: 17_600, status: 'PARTIAL' }, correctionNetting: { amountCents: 17_600, effectiveDate: new Date('2026-08-04') } })
    expect(first.postingJournalEntry!.lines.map(line => ({ number: line.account.number, debit: line.debitCents, credit: line.creditCents }))).toEqual([{ number: 1600, debit: 22_600, credit: 0 }, { number: 4930, debit: 0, credit: 10_000 }, { number: 1571, debit: 0, credit: 700 }, { number: 4930, debit: 0, credit: 10_000 }, { number: 1576, debit: 0, credit: 1_900 }])
    await expect(prisma.openItem.findUniqueOrThrow({ where: { id: original.openItem!.id } })).resolves.toMatchObject({ side: 'CREDIT', allocatedAmountCents: 22_600, status: 'SETTLED' })
    await expect(prisma.vatPostingRecord.findMany({ where: { ownerId: 'tenant-a', documentId: 'credit-evidence' }, orderBy: { rateBasisPoints: 'asc' } })).resolves.toMatchObject([{ ruleId: 'DE_REDUCED', netBaseCents: -10_000, inputTaxCents: -700, grossCents: -10_700 }, { ruleId: 'DE_STANDARD', netBaseCents: -10_000, inputTaxCents: -1_900, grossCents: -11_900 }])
    await expect(prisma.auditEvent.findFirst({ where: { ownerId: 'tenant-a', action: 'INCOMING_SUPPLIER_CREDIT_NOTE_POSTED' } })).resolves.toBeTruthy()
    const reopened = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${databasePath}` }) }); const durable = await reopened.commercialDocument.findUnique({ where: { id: first.id }, include: { openItem: true, correctionNetting: true, postingJournalEntry: { include: { documents: true } } } }); await reopened.$disconnect()
    expect(durable).toMatchObject({ openItem: { status: 'PARTIAL', allocatedAmountCents: 17_600 }, correctionNetting: { amountCents: 17_600 }, postingJournalEntry: { documents: [{ documentId: 'credit-evidence' }] } })
  })

  it.each([{ label: 'negative -1 cent', amountCents: -1 }, { label: 'zero cents', amountCents: 0 }])('Given direct database insertion with $label, when correction netting trigger validation runs, then persistence rejects it without changing derived balances', async ({ amountCents }) => {
    const existing = await prisma.correctionNetting.findFirstOrThrow({ where: { ownerId: 'tenant-a' } })
    const before = await prisma.openItem.findMany({ where: { ownerId: 'tenant-a', id: { in: [existing.originalOpenItemId, existing.creditOpenItemId] } }, orderBy: { id: 'asc' } })
    await expect(prisma.$executeRawUnsafe(
      'INSERT INTO "CorrectionNetting" ("id","ownerId","correctionDocumentId","originalOpenItemId","creditOpenItemId","journalEntryId","amountCents","requestKey","requestHash","effectiveDate","createdBy") VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      `unsafe-netting-${amountCents}`, existing.ownerId, existing.correctionDocumentId, existing.originalOpenItemId, existing.creditOpenItemId, existing.journalEntryId, amountCents, `unsafe-request-${amountCents}`, 'f'.repeat(64), existing.effectiveDate, 'attacker',
    )).rejects.toThrow(/invalid tenant correction netting/i)
    await expect(prisma.openItem.findMany({ where: { ownerId: 'tenant-a', id: { in: [existing.originalOpenItemId, existing.creditOpenItemId] } }, orderBy: { id: 'asc' } })).resolves.toEqual(before)
  })

  it('Given wrong-tenant, changed-effective-date, and over-credit attempts, when posted, then all fail closed without additional journals or corrections', async () => {
    const journals = await prisma.journalEntry.count({ where: { ownerId: 'tenant-a' } }); const corrections = await prisma.commercialDocument.count({ where: { ownerId: 'tenant-a', kind: 'CREDIT_NOTE' } })
    await expect(creditApi.postIncomingSupplierCredit('tenant-b', 'user-b', 'credit-evidence', { effectiveDate: '2026-08-04', requestKey: 'wrong-tenant-request-01', reason: 'Wrong tenant' })).rejects.toThrow(/linked/i)
    await expect(creditApi.postIncomingSupplierCredit('tenant-a', 'user-a', 'credit-evidence', { effectiveDate: '2026-08-05', requestKey: 'changed-date-request-01', reason: 'Changed date' })).rejects.toThrow(/different adjustment-effective date/i)
    const excessive: StructuredInvoiceData & { kind: 'credit-note'; correctedInvoiceNumber: string } = { ...originalData, kind: 'credit-note', invoiceNumber: 'GS-OVER', correctedInvoiceNumber: originalData.invoiceNumber, issueDate: '2026-08-05', supplyDate: '2026-08-05', lines: [{ ...originalData.lines[0], netAmountCents: 100 }], netAmountCents: 100, taxAmountCents: 7, grossAmountCents: 107 }
    await createCreditEvidence('over-evidence', 'over-structured', excessive)
    await expect(creditApi.postIncomingSupplierCredit('tenant-a', 'user-a', 'over-evidence', { effectiveDate: '2026-08-05', requestKey: 'over-credit-request-001', reason: 'Over-credit' })).rejects.toThrow(/VAT-rate base|invoice amount/i)
    await expect(prisma.journalEntry.count({ where: { ownerId: 'tenant-a' } })).resolves.toBe(journals)
    await expect(prisma.commercialDocument.count({ where: { ownerId: 'tenant-a', kind: 'CREDIT_NOTE' } })).resolves.toBe(corrections)
  })
})

async function createCreditEvidence(documentId: string, id: string, data: StructuredInvoiceData & { kind: 'credit-note'; correctedInvoiceNumber: string }) {
  await prisma.documentRecord.create({ data: { id: documentId, ownerId: 'tenant-a', payload: '{}' } })
  await prisma.structuredInvoice.create({ data: { id, ownerId: 'tenant-a', documentId, syntax: data.syntax, kind: data.kind, direction: 'INCOMING', issuerKey: 'supplier-key', invoiceNumber: data.invoiceNumber, issueDate: new Date(data.issueDate), structuredHash: createHashFor(id), originalMediaType: 'application/xml', structuredOriginal: Buffer.from('<CreditNote/>'), data: JSON.stringify(data), provenance: '{}', renderedHtml: '<p>Credit</p>', correctsId: 'original-structured' } })
}
function createHashFor(value: string) { return value.padEnd(64, 'z').slice(0, 64) }
