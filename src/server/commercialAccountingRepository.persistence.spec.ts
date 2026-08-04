import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PrismaClient } from '@/generated/prisma/client'
import type { StructuredInvoiceData } from '@/core/eInvoice'

vi.mock('server-only', () => ({}))
const directory = mkdtempSync(join(tmpdir(), 'accounting-commercial-repository-'))
const databasePath = join(directory, 'test.db').replace(/\\/g, '/')
let api: typeof import('./commercialAccountingRepository')
let prisma: typeof import('@/server/persistence/client').prisma

beforeAll(async () => {
  const database = new DatabaseSync(databasePath)
  const migrations = resolve(process.cwd(), 'prisma', 'migrations')
  for (const name of readdirSync(migrations, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort()) database.exec(readFileSync(join(migrations, name, 'migration.sql'), 'utf8'))
  database.close()
  process.env.DATABASE_URL = `file:${databasePath}`
  api = await import('./commercialAccountingRepository')
  prisma = (await import('@/server/persistence/client')).prisma
  await prisma.ledgerProfile.createMany({ data: [{ ownerId: 'tenant-a', chart: 'SKR03', accountLength: 4 }, { ownerId: 'tenant-b', chart: 'SKR03', accountLength: 4 }] })
  await prisma.fiscalYear.createMany({ data: [
    { id: 'fy-a', ownerId: 'tenant-a', year: 2026, startsAt: new Date('2026-01-01'), endsAt: new Date('2026-12-31') },
    { id: 'fy-b', ownerId: 'tenant-b', year: 2026, startsAt: new Date('2026-01-01'), endsAt: new Date('2026-12-31') },
  ] })
  await prisma.journalEntry.createMany({ data: [
    { id: 'invoice-journal-a', ownerId: 'tenant-a', fiscalYearId: 'fy-a', sequenceNumber: 1, bookingDate: new Date('2026-08-01'), documentNumber: 'J-INV-1', description: 'Invoice posting' },
    { id: 'invoice-journal-a2', ownerId: 'tenant-a', fiscalYearId: 'fy-a', sequenceNumber: 2, bookingDate: new Date('2026-08-02'), documentNumber: 'J-INV-2', description: 'Second invoice posting' },
    { id: 'payment-a1', ownerId: 'tenant-a', fiscalYearId: 'fy-a', sequenceNumber: 3, bookingDate: new Date('2026-08-10'), documentNumber: 'PAY-1', description: 'Partial receipt' },
    { id: 'payment-a2', ownerId: 'tenant-a', fiscalYearId: 'fy-a', sequenceNumber: 4, bookingDate: new Date('2026-08-11'), documentNumber: 'PAY-2', description: 'Final receipt' },
    { id: 'payment-a3', ownerId: 'tenant-a', fiscalYearId: 'fy-a', sequenceNumber: 5, bookingDate: new Date('2026-08-12'), documentNumber: 'PAY-3', description: 'Competing receipt' },
    { id: 'journal-b', ownerId: 'tenant-b', fiscalYearId: 'fy-b', sequenceNumber: 1, bookingDate: new Date('2026-08-01'), documentNumber: 'B-1', description: 'Other tenant' },
  ] })
  await prisma.ledgerAccount.createMany({ data: [
    { id: 'bank-a', ownerId: 'tenant-a', number: 1200, name: 'Bank', category: 'ASSET' },
    { id: 'receivable-a', ownerId: 'tenant-a', number: 1400, name: 'Receivables', category: 'ASSET' },
    { id: 'output-vat-reduced-a', ownerId: 'tenant-a', number: 1771, name: 'Output VAT 7%', category: 'LIABILITY' },
    { id: 'output-vat-a', ownerId: 'tenant-a', number: 1776, name: 'Output VAT 19%', category: 'LIABILITY' },
    { id: 'revenue-reduced-a', ownerId: 'tenant-a', number: 8300, name: 'Revenue 7%', category: 'REVENUE' },
    { id: 'revenue-a', ownerId: 'tenant-a', number: 8400, name: 'Revenue 19%', category: 'REVENUE' },
  ] })
  await prisma.journalLine.createMany({ data: [
    { id: 'payment-a1-debit', journalEntryId: 'payment-a1', accountId: 'bank-a', debitCents: 5_000 }, { id: 'payment-a1-credit', journalEntryId: 'payment-a1', accountId: 'receivable-a', creditCents: 5_000 },
    { id: 'payment-a2-debit', journalEntryId: 'payment-a2', accountId: 'bank-a', debitCents: 6_900 }, { id: 'payment-a2-credit', journalEntryId: 'payment-a2', accountId: 'receivable-a', creditCents: 6_900 },
    { id: 'payment-a3-debit', journalEntryId: 'payment-a3', accountId: 'bank-a', debitCents: 6_900 }, { id: 'payment-a3-credit', journalEntryId: 'payment-a3', accountId: 'receivable-a', creditCents: 6_900 },
  ] })
  await prisma.documentRecord.createMany({ data: [
    { id: 'evidence-a', ownerId: 'tenant-a', payload: '{}' },
    { id: 'evidence-a2', ownerId: 'tenant-a', payload: '{}' },
    { id: 'evidence-structured', ownerId: 'tenant-a', payload: '{}' },
    { id: 'evidence-structured-mixed', ownerId: 'tenant-a', payload: '{}' },
    { id: 'evidence-structured-foreign', ownerId: 'tenant-a', payload: '{}' },
    { id: 'evidence-b', ownerId: 'tenant-b', payload: '{}' },
  ] })
  const structuredData = { syntax: 'UBL', kind: 'invoice', invoiceNumber: '2026-000001', issueDate: '2026-08-04', supplyDate: '2026-08-04', seller: { name: 'Tenant UG', street: 'Main 1', postalCode: '10115', city: 'Berlin', countryCode: 'DE', taxId: '12/345/67890' }, buyer: { name: 'Musterkunde GmbH', street: 'Kundenweg 2', postalCode: '50667', city: 'Köln', countryCode: 'DE', vatId: 'DE987654321' }, lines: [{ description: 'Software consulting', quantity: 1, unitCode: 'C62', netAmountCents: 10000, taxRateBasisPoints: 1900, taxCategoryCode: 'S' }], netAmountCents: 10000, taxAmountCents: 1900, grossAmountCents: 11900, currency: 'EUR' }
  await prisma.structuredInvoice.create({ data: { id: 'structured-a', ownerId: 'tenant-a', documentId: 'evidence-structured', syntax: 'UBL', kind: 'invoice', direction: 'OUTGOING', issuerKey: 'tenant-a', invoiceNumber: '2026-000001', issueDate: new Date('2026-08-04'), structuredHash: 'a'.repeat(64), originalMediaType: 'application/xml', structuredOriginal: Buffer.from('<Invoice/>'), data: JSON.stringify(structuredData), provenance: '{}', renderedHtml: '<p>Invoice</p>' } })
})

afterAll(async () => {
  await prisma.$disconnect()
  delete process.env.DATABASE_URL
  rmSync(directory, { recursive: true, force: true })
})

describe('persistent commercial accounting repository', () => {
  let partnerId = ''
  let documentId = ''
  let openItemId = ''

  it('Given tenant master data, when a customer is created, then it persists with tenant scope and an audit event', async () => {
    const partner = await api.createBusinessPartner('tenant-a', 'user-a', { partnerNumber: 'K-10001', role: 'CUSTOMER', name: 'Musterkunde GmbH', countryCode: 'de', vatId: 'DE987654321', paymentTermDays: 14 })
    partnerId = partner.id
    expect(partner).toMatchObject({ ownerId: 'tenant-a', partnerNumber: 'K-10001', role: 'CUSTOMER', countryCode: 'DE' })
    await expect(api.listBusinessPartners('tenant-b')).resolves.toEqual([])
    await expect(prisma.auditEvent.findFirst({ where: { ownerId: 'tenant-a', action: 'BUSINESS_PARTNER_CREATED', objectId: partner.id } })).resolves.toBeTruthy()
  })

  it('Given an issued outgoing structured invoice, when it is registered or retried, then one evidenced ledger posting, VAT detail and open receivable are created atomically', async () => {
    const first = await api.registerOutgoingStructuredInvoice('tenant-a', 'user-a', 'structured-a')
    const replay = await api.registerOutgoingStructuredInvoice('tenant-a', 'user-a', 'structured-a')
    expect(replay.id).toBe(first.id)
    expect(first).toMatchObject({ status: 'POSTED', structuredInvoiceId: 'structured-a', businessPartnerId: partnerId, postingJournalEntryId: expect.any(String), openItem: { status: 'OPEN', originalAmountCents: 11_900 } })
    await expect(prisma.commercialDocument.count({ where: { ownerId: 'tenant-a', structuredInvoiceId: 'structured-a' } })).resolves.toBe(1)
    const journal = await prisma.journalEntry.findUniqueOrThrow({ where: { id: first.postingJournalEntryId! }, include: { lines: { include: { account: true } }, documents: true } })
    expect(journal.lines.map(line => ({ number: line.account.number, debit: line.debitCents, credit: line.creditCents })).sort((left, right) => left.number - right.number)).toEqual([{ number: 1400, debit: 11_900, credit: 0 }, { number: 1776, debit: 0, credit: 1_900 }, { number: 8400, debit: 0, credit: 10_000 }])
    expect(journal.documents).toEqual([{ journalEntryId: journal.id, documentId: 'evidence-structured' }])
    await expect(prisma.vatPostingRecord.findFirst({ where: { ownerId: 'tenant-a', documentId: 'evidence-structured' } })).resolves.toMatchObject({ ruleId: 'DE_STANDARD', netBaseCents: 10_000, outputTaxCents: 1_900 })
  })

  it('Given a supported invoice and a migrated tenant ledger, when accounting is preflighted, then readiness passes while unsupported facts leave every issuance table unchanged', async () => {
    const data = JSON.parse((await prisma.structuredInvoice.findUniqueOrThrow({ where: { id: 'structured-a' } })).data) as StructuredInvoiceData
    await expect(api.preflightOutgoingStructuredInvoiceAccounting('tenant-a', data)).resolves.toBeUndefined()
    const before = await Promise.all([
      prisma.invoiceIssuanceRequest.count({ where: { ownerId: 'tenant-a' } }),
      prisma.invoiceNumberReservation.count({ where: { ownerId: 'tenant-a' } }),
      prisma.structuredInvoice.count({ where: { ownerId: 'tenant-a' } }),
      prisma.documentRecord.count({ where: { ownerId: 'tenant-a' } }),
    ])
    await expect(api.preflightOutgoingStructuredInvoiceAccounting('tenant-a', { ...data, buyer: { ...data.buyer, countryCode: 'NL' } })).rejects.toThrow(/domestic EUR/)
    await expect(Promise.all([
      prisma.invoiceIssuanceRequest.count({ where: { ownerId: 'tenant-a' } }),
      prisma.invoiceNumberReservation.count({ where: { ownerId: 'tenant-a' } }),
      prisma.structuredInvoice.count({ where: { ownerId: 'tenant-a' } }),
      prisma.documentRecord.count({ where: { ownerId: 'tenant-a' } }),
    ])).resolves.toEqual(before)
  })

  it('Given one invoice with reduced and standard VAT lines, when it is posted, then exact tax groups use the canonical 7% and 19% revenue/control accounts', async () => {
    const original = JSON.parse((await prisma.structuredInvoice.findUniqueOrThrow({ where: { id: 'structured-a' } })).data) as StructuredInvoiceData
    const mixed = { ...original, invoiceNumber: '2026-000002', lines: [{ ...original.lines[0], description: 'Standard service' }, { ...original.lines[0], description: 'Reduced item', netAmountCents: 1_000, taxRateBasisPoints: 700 }], netAmountCents: 11_000, taxAmountCents: 1_970, grossAmountCents: 12_970 }
    await prisma.structuredInvoice.create({ data: { id: 'structured-mixed', ownerId: 'tenant-a', documentId: 'evidence-structured-mixed', syntax: 'UBL', kind: 'invoice', direction: 'OUTGOING', issuerKey: 'tenant-a', invoiceNumber: mixed.invoiceNumber, issueDate: new Date('2026-08-05'), structuredHash: 'b'.repeat(64), originalMediaType: 'application/xml', structuredOriginal: Buffer.from('<Invoice/>'), data: JSON.stringify({ ...mixed, issueDate: '2026-08-05', supplyDate: '2026-08-05' }), provenance: '{}', renderedHtml: '<p>Mixed invoice</p>' } })
    const posted = await api.registerOutgoingStructuredInvoice('tenant-a', 'user-a', 'structured-mixed')
    const journal = await prisma.journalEntry.findUniqueOrThrow({ where: { id: posted.postingJournalEntryId! }, include: { lines: { include: { account: true } } } })
    expect(journal.lines.map(line => ({ number: line.account.number, debit: line.debitCents, credit: line.creditCents })).sort((left, right) => left.number - right.number)).toEqual([
      { number: 1400, debit: 12_970, credit: 0 }, { number: 1771, debit: 0, credit: 70 }, { number: 1776, debit: 0, credit: 1_900 }, { number: 8300, debit: 0, credit: 1_000 }, { number: 8400, debit: 0, credit: 10_000 },
    ])
    await expect(prisma.vatPostingRecord.findMany({ where: { ownerId: 'tenant-a', documentId: 'evidence-structured-mixed' }, orderBy: { rateBasisPoints: 'asc' } })).resolves.toMatchObject([{ ruleId: 'DE_REDUCED', taxCents: 70 }, { ruleId: 'DE_STANDARD', taxCents: 1_900 }])
  })

  it('Given a posted mixed-rate invoice, when a partial 7% credit note is registered, then its reversing journal, negative VAT and immutable netting persist atomically', async () => {
    const original = await prisma.structuredInvoice.findUniqueOrThrow({ where: { id: 'structured-mixed' } }); const originalData = JSON.parse(original.data) as StructuredInvoiceData
    await prisma.documentRecord.create({ data: { id: 'evidence-credit-partial', ownerId: 'tenant-a', payload: '{}' } })
    const data = { ...originalData, kind: 'credit-note' as const, invoiceNumber: '2026-000010', correctedInvoiceNumber: originalData.invoiceNumber, issueDate: '2026-08-06', supplyDate: '2026-08-06', lines: [{ ...originalData.lines[1], netAmountCents: 1_000 }], netAmountCents: 1_000, taxAmountCents: 70, grossAmountCents: 1_070 }
    await prisma.structuredInvoice.create({ data: { id: 'structured-credit-partial', ownerId: 'tenant-a', documentId: 'evidence-credit-partial', syntax: 'UBL', kind: 'credit-note', direction: 'OUTGOING', issuerKey: original.issuerKey, invoiceNumber: data.invoiceNumber, issueDate: new Date(data.issueDate), structuredHash: 'e'.repeat(64), originalMediaType: 'application/xml', structuredOriginal: Buffer.from('<CreditNote/>'), data: JSON.stringify(data), provenance: '{}', renderedHtml: '<p>Credit</p>', correctsId: original.id } })
    const correction = await api.registerOutgoingStructuredCorrection('tenant-a', 'user-a', 'structured-credit-partial', 'credit-partial-request-01')
    expect(correction).toMatchObject({ kind: 'CREDIT_NOTE', correctsId: expect.any(String), openItem: { side: 'CREDIT', status: 'SETTLED', originalAmountCents: 1_070 }, correctionNetting: { amountCents: 1_070 } })
    const journal = await prisma.journalEntry.findUniqueOrThrow({ where: { id: correction.postingJournalEntryId! }, include: { lines: { include: { account: true } } } })
    expect(journal.lines.map(line => ({ number: line.account.number, debit: line.debitCents, credit: line.creditCents })).sort((a, b) => a.number - b.number)).toEqual([{ number: 1400, debit: 0, credit: 1_070 }, { number: 1771, debit: 70, credit: 0 }, { number: 8300, debit: 1_000, credit: 0 }])
    await expect(prisma.vatPostingRecord.findFirst({ where: { documentId: 'evidence-credit-partial' } })).resolves.toMatchObject({ netBaseCents: -1_000, taxCents: -70, outputTaxCents: -70 })
    await expect(prisma.$executeRawUnsafe(`UPDATE CorrectionNetting SET amountCents=0 WHERE correctionDocumentId='${correction.id}'`)).rejects.toThrow(/immutable/)
    await expect(prisma.$executeRawUnsafe(`DELETE FROM CorrectionNetting WHERE correctionDocumentId='${correction.id}'`)).rejects.toThrow(/immutable/)
  })

  it('Given an untouched posted outgoing invoice, when a full cancellation is approved, then it appends a linked full journal reversal and settles both open items', async () => {
    const template = await prisma.structuredInvoice.findUniqueOrThrow({ where: { id: 'structured-a' } }); const originalData = JSON.parse(template.data) as StructuredInvoiceData
    await prisma.documentRecord.createMany({ data: [{ id: 'evidence-cancel-original', ownerId: 'tenant-a', payload: '{}' }, { id: 'evidence-cancellation', ownerId: 'tenant-a', payload: '{}' }] })
    const invoiceData = { ...originalData, invoiceNumber: '2026-000020', issueDate: '2026-08-12', supplyDate: '2026-08-12' }
    await prisma.structuredInvoice.create({ data: { id: 'structured-cancel-original', ownerId: 'tenant-a', documentId: 'evidence-cancel-original', syntax: 'UBL', kind: 'invoice', direction: 'OUTGOING', issuerKey: template.issuerKey, invoiceNumber: invoiceData.invoiceNumber, issueDate: new Date(invoiceData.issueDate), structuredHash: '2'.repeat(64), originalMediaType: 'application/xml', structuredOriginal: Buffer.from('<Invoice/>'), data: JSON.stringify(invoiceData), provenance: '{}', renderedHtml: '<p>Original</p>' } })
    const original = await api.registerOutgoingStructuredInvoice('tenant-a', 'user-a', 'structured-cancel-original')
    const cancellationData = { ...invoiceData, kind: 'cancellation' as const, invoiceNumber: '2026-000021', correctedInvoiceNumber: invoiceData.invoiceNumber, issueDate: '2026-08-13', supplyDate: '2026-08-13' }
    await api.preflightOutgoingStructuredCorrectionAccounting('tenant-a', 'structured-cancel-original', cancellationData)
    await prisma.structuredInvoice.create({ data: { id: 'structured-cancellation', ownerId: 'tenant-a', documentId: 'evidence-cancellation', syntax: 'UBL', kind: 'cancellation', direction: 'OUTGOING', issuerKey: template.issuerKey, invoiceNumber: cancellationData.invoiceNumber, issueDate: new Date(cancellationData.issueDate), structuredHash: '3'.repeat(64), originalMediaType: 'application/xml', structuredOriginal: Buffer.from('<Invoice/>'), data: JSON.stringify(cancellationData), provenance: '{}', renderedHtml: '<p>Cancellation</p>', correctsId: 'structured-cancel-original' } })
    const cancelled = await api.registerOutgoingStructuredCorrection('tenant-a', 'user-a', 'structured-cancellation', 'full-cancellation-request1')
    await expect(prisma.journalEntry.findUnique({ where: { id: cancelled.postingJournalEntryId! } })).resolves.toMatchObject({ reversalOfId: original.postingJournalEntryId, source: 'OUTGOING_CREDIT_NOTE' })
    await expect(prisma.openItem.findUnique({ where: { id: original.openItem!.id } })).resolves.toMatchObject({ status: 'SETTLED', allocatedAmountCents: 11_900 })
    expect(cancelled).toMatchObject({ correctionNetting: { amountCents: 11_900 }, openItem: { status: 'SETTLED', allocatedAmountCents: 11_900 } })
  })

  it('Given a prior partial customer payment, when the full invoice is credited, then netting settles the debit and retains the excess customer credit balance', async () => {
    const originalCommercial = await prisma.commercialDocument.findUniqueOrThrow({ where: { ownerId_structuredInvoiceId: { ownerId: 'tenant-a', structuredInvoiceId: 'structured-a' } }, include: { openItem: true } })
    await prisma.journalEntry.create({ data: { id: 'credit-test-payment', ownerId: 'tenant-a', fiscalYearId: 'fy-a', sequenceNumber: 90, bookingDate: new Date('2026-08-07'), documentNumber: 'PAY-CREDIT', description: 'Prior partial customer receipt', lines: { create: [{ accountId: 'bank-a', debitCents: 5_000 }, { accountId: 'receivable-a', creditCents: 5_000 }] } } })
    const payment = await api.recordPaymentSettlement('tenant-a', 'user-a', { businessPartnerId: originalCommercial.businessPartnerId, journalEntryId: 'credit-test-payment', direction: 'RECEIPT', currency: 'EUR', amountCents: 5_000, occurredOn: '2026-08-07', reason: 'Partial receipt' })
    await api.allocateSettlement('tenant-a', 'user-a', 'credit-payment-allocation-1', { openItemId: originalCommercial.openItem!.id, settlementId: payment.id, amountCents: 5_000, effectiveDate: '2026-08-07', reason: 'Partial receipt allocated' })
    const original = await prisma.structuredInvoice.findUniqueOrThrow({ where: { id: 'structured-a' } }); const originalData = JSON.parse(original.data) as StructuredInvoiceData
    await prisma.documentRecord.create({ data: { id: 'evidence-credit-full', ownerId: 'tenant-a', payload: '{}' } })
    const data = { ...originalData, kind: 'credit-note' as const, invoiceNumber: '2026-000011', correctedInvoiceNumber: originalData.invoiceNumber, issueDate: '2026-08-08', supplyDate: '2026-08-08' }
    await prisma.structuredInvoice.create({ data: { id: 'structured-credit-full', ownerId: 'tenant-a', documentId: 'evidence-credit-full', syntax: 'UBL', kind: 'credit-note', direction: 'OUTGOING', issuerKey: original.issuerKey, invoiceNumber: data.invoiceNumber, issueDate: new Date(data.issueDate), structuredHash: 'f'.repeat(64), originalMediaType: 'application/xml', structuredOriginal: Buffer.from('<CreditNote/>'), data: JSON.stringify(data), provenance: '{}', renderedHtml: '<p>Full credit</p>', correctsId: original.id } })
    const [first, replay] = await Promise.all([api.registerOutgoingStructuredCorrection('tenant-a', 'user-a', 'structured-credit-full', 'credit-full-request-0001'), api.registerOutgoingStructuredCorrection('tenant-a', 'user-a', 'structured-credit-full', 'credit-full-request-0001')])
    expect(replay.id).toBe(first.id); expect(first.correctionNetting).toMatchObject({ amountCents: 6_900 })
    await expect(prisma.openItem.findUnique({ where: { id: originalCommercial.openItem!.id } })).resolves.toMatchObject({ allocatedAmountCents: 11_900, status: 'SETTLED' })
    await expect(prisma.openItem.findUnique({ where: { id: first.openItem!.id } })).resolves.toMatchObject({ allocatedAmountCents: 6_900, originalAmountCents: 11_900, status: 'PARTIAL' })
    await expect(prisma.commercialDocument.findUnique({ where: { id: originalCommercial.id } })).resolves.toMatchObject({ status: 'CORRECTED' })
  })

  it('Given unsupported or unowned correction claims, when preflight runs, then replacement, foreign, excessive and missing-original cases leave every accounting table unchanged', async () => {
    const original = await prisma.structuredInvoice.findUniqueOrThrow({ where: { id: 'structured-mixed' } }); const data = JSON.parse(original.data) as StructuredInvoiceData
    const candidate = { ...data, kind: 'credit-note' as const, issueDate: '2026-08-09', supplyDate: '2026-08-09', lines: [{ ...data.lines[0], netAmountCents: 1_000 }], netAmountCents: 1_000, taxAmountCents: 190, grossAmountCents: 1_190 }
    const before = await Promise.all([prisma.commercialDocument.count(), prisma.journalEntry.count(), prisma.vatPostingRecord.count(), prisma.openItem.count(), prisma.correctionNetting.count()])
    await expect(api.preflightOutgoingStructuredCorrectionAccounting('tenant-a', original.id, { ...candidate, kind: 'correction' })).rejects.toThrow(/replacement correction semantics/)
    await expect(api.preflightOutgoingStructuredCorrectionAccounting('tenant-a', original.id, { ...candidate, buyer: { ...candidate.buyer, countryCode: 'NL' } })).rejects.toThrow(/domestic EUR/)
    await expect(api.preflightOutgoingStructuredCorrectionAccounting('tenant-a', original.id, { ...candidate, lines: [{ ...candidate.lines[0], netAmountCents: 20_000 }], netAmountCents: 20_000, taxAmountCents: 3_800, grossAmountCents: 23_800 })).rejects.toThrow(/exceeds/)
    await expect(api.preflightOutgoingStructuredCorrectionAccounting('tenant-b', original.id, candidate)).rejects.toThrow(/does not belong|unavailable/)
    await expect(Promise.all([prisma.commercialDocument.count(), prisma.journalEntry.count(), prisma.vatPostingRecord.count(), prisma.openItem.count(), prisma.correctionNetting.count()])).resolves.toEqual(before)
  })

  it('Given a late immutable-netting conflict, when correction accounting reaches the final write, then its journal, VAT, commercial document and open item roll back together', async () => {
    const original = await prisma.structuredInvoice.findUniqueOrThrow({ where: { id: 'structured-mixed' } }); const originalData = JSON.parse(original.data) as StructuredInvoiceData
    await prisma.documentRecord.create({ data: { id: 'evidence-credit-rollback', ownerId: 'tenant-a', payload: '{}' } }); const data = { ...originalData, kind: 'credit-note' as const, invoiceNumber: '2026-000012', correctedInvoiceNumber: originalData.invoiceNumber, issueDate: '2026-08-10', supplyDate: '2026-08-10', lines: [{ ...originalData.lines[0], netAmountCents: 100 }], netAmountCents: 100, taxAmountCents: 19, grossAmountCents: 119 }
    await prisma.structuredInvoice.create({ data: { id: 'structured-credit-rollback', ownerId: 'tenant-a', documentId: 'evidence-credit-rollback', syntax: 'UBL', kind: 'credit-note', direction: 'OUTGOING', issuerKey: original.issuerKey, invoiceNumber: data.invoiceNumber, issueDate: new Date(data.issueDate), structuredHash: '1'.repeat(64), originalMediaType: 'application/xml', structuredOriginal: Buffer.from('<CreditNote/>'), data: JSON.stringify(data), provenance: '{}', renderedHtml: '<p>Rollback</p>', correctsId: original.id } })
    const before = await Promise.all([prisma.commercialDocument.count(), prisma.journalEntry.count(), prisma.vatPostingRecord.count(), prisma.openItem.count(), prisma.correctionNetting.count()])
    await expect(api.registerOutgoingStructuredCorrection('tenant-a', 'user-a', 'structured-credit-rollback', 'credit-partial-request-01')).rejects.toThrow(/Unique constraint|unique/i)
    await expect(Promise.all([prisma.commercialDocument.count(), prisma.journalEntry.count(), prisma.vatPostingRecord.count(), prisma.openItem.count(), prisma.correctionNetting.count()])).resolves.toEqual(before)
  })

  it('Given an unsupported foreign VAT case, when automatic registration is attempted, then no journal, VAT detail, open item or commercial document is written', async () => {
    const original = JSON.parse((await prisma.structuredInvoice.findUniqueOrThrow({ where: { id: 'structured-a' } })).data) as StructuredInvoiceData
    await prisma.structuredInvoice.create({ data: { id: 'structured-foreign', ownerId: 'tenant-a', documentId: 'evidence-structured-foreign', syntax: 'UBL', kind: 'invoice', direction: 'OUTGOING', issuerKey: 'tenant-a', invoiceNumber: '2026-000003', issueDate: new Date('2026-08-06'), structuredHash: 'c'.repeat(64), originalMediaType: 'application/xml', structuredOriginal: Buffer.from('<Invoice/>'), data: JSON.stringify({ ...original, invoiceNumber: '2026-000003', issueDate: '2026-08-06', supplyDate: '2026-08-06', buyer: { ...original.buyer, countryCode: 'NL' } }), provenance: '{}', renderedHtml: '<p>Foreign invoice</p>' } })
    await expect(api.registerOutgoingStructuredInvoice('tenant-a', 'user-a', 'structured-foreign')).rejects.toThrow(/domestic EUR/)
    await expect(prisma.commercialDocument.count({ where: { ownerId: 'tenant-a', structuredInvoiceId: 'structured-foreign' } })).resolves.toBe(0)
    await expect(prisma.journalDocumentAttachment.count({ where: { documentId: 'evidence-structured-foreign' } })).resolves.toBe(0)
    await expect(prisma.vatPostingRecord.count({ where: { ownerId: 'tenant-a', documentId: 'evidence-structured-foreign' } })).resolves.toBe(0)
  })

  it('Given a customer, evidence, and posted journal, when an invoice is finalized, then document and open item persist atomically', async () => {
    const draft = await api.createCommercialDocumentDraft('tenant-a', 'user-a', { partnerId, direction: 'RECEIVABLE', currency: 'EUR', netMinor: 10_000, taxMinor: 1_900, grossMinor: 11_900, serviceDate: '2026-08-01', dueDate: '2026-08-15', description: 'Consulting' })
    documentId = draft.id
    const final = await api.finalizeCommercialDocument('tenant-a', 'user-a', { draftId: draft.id, documentNumber: 'RE-2026-0001', issueDate: '2026-08-01', issuerIdentity: 'tenant-a', evidenceDocumentId: 'evidence-a', postingJournalEntryId: 'invoice-journal-a', reason: 'Invoice approved and posted' })
    expect(final).toMatchObject({ ownerId: 'tenant-a', status: 'POSTED', documentNumber: 'RE-2026-0001', postingJournalEntryId: 'invoice-journal-a', openItem: { status: 'OPEN', originalAmountCents: 11_900, allocatedAmountCents: 0 } })
    openItemId = final.openItem!.id

    const reopened = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${databasePath}` }) })
    await expect(reopened.commercialDocument.findUnique({ where: { id: draft.id }, include: { openItem: true } })).resolves.toMatchObject({ status: 'POSTED', openItem: { originalAmountCents: 11_900 } })
    await reopened.$disconnect()
  })

  it('Given another tenant evidence or journal, when finalization is attempted, then the transaction leaves the draft untouched', async () => {
    const draft = await api.createCommercialDocumentDraft('tenant-a', 'user-a', { partnerId, direction: 'RECEIVABLE', currency: 'EUR', netMinor: 2_000, taxMinor: 380, grossMinor: 2_380, serviceDate: '2026-08-02', dueDate: '2026-08-16', description: 'More consulting' })
    await expect(api.finalizeCommercialDocument('tenant-a', 'user-a', { draftId: draft.id, documentNumber: 'RE-2026-X', issueDate: '2026-08-02', issuerIdentity: 'tenant-a', evidenceDocumentId: 'evidence-b', postingJournalEntryId: 'journal-b', reason: 'Must fail' })).rejects.toThrow(/evidence document/)
    await expect(prisma.commercialDocument.findUnique({ where: { id: draft.id } })).resolves.toMatchObject({ status: 'DRAFT', documentNumber: null })
    await expect(prisma.openItem.findFirst({ where: { commercialDocumentId: draft.id } })).resolves.toBeNull()
  })

  it('Given an open receivable, when a partial allocation is retried, then it is idempotent and conflicting key reuse is rejected', async () => {
    const settlement = await api.recordPaymentSettlement('tenant-a', 'user-a', { businessPartnerId: partnerId, journalEntryId: 'payment-a1', direction: 'RECEIPT', currency: 'EUR', amountCents: 5_000, occurredOn: '2026-08-10', reason: 'Bank receipt registered' })
    const input = { openItemId, settlementId: settlement.id, amountCents: 5_000, effectiveDate: '2026-08-10', reason: 'Bank receipt matched' }
    const first = await api.allocateSettlement('tenant-a', 'user-a', 'settlement-request-0001', input)
    const replay = await api.allocateSettlement('tenant-a', 'user-a', 'settlement-request-0001', input)
    expect(replay.id).toBe(first.id)
    await expect(api.allocateSettlement('tenant-a', 'user-a', 'settlement-request-0001', { ...input, amountCents: 4_999 })).rejects.toThrow(/different facts/)
    await expect(prisma.openItem.findUnique({ where: { id: openItemId } })).resolves.toMatchObject({ allocatedAmountCents: 5_000, status: 'PARTIAL', version: 2 })
  })

  it('Given two allocations competing for the final remainder, when they run concurrently, then only one can settle the item', async () => {
    const settlementA = await api.recordPaymentSettlement('tenant-a', 'user-a', { businessPartnerId: partnerId, journalEntryId: 'payment-a2', direction: 'RECEIPT', currency: 'EUR', amountCents: 6_900, occurredOn: '2026-08-11', reason: 'Receipt A registered' })
    const settlementB = await api.recordPaymentSettlement('tenant-a', 'user-a', { businessPartnerId: partnerId, journalEntryId: 'payment-a3', direction: 'RECEIPT', currency: 'EUR', amountCents: 6_900, occurredOn: '2026-08-12', reason: 'Receipt B registered' })
    const results = await Promise.allSettled([
      api.allocateSettlement('tenant-a', 'user-a', 'settlement-request-0002', { openItemId, settlementId: settlementA.id, amountCents: 6_900, effectiveDate: '2026-08-11', reason: 'Final receipt A' }),
      api.allocateSettlement('tenant-a', 'user-a', 'settlement-request-0003', { openItemId, settlementId: settlementB.id, amountCents: 6_900, effectiveDate: '2026-08-12', reason: 'Final receipt B' }),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    await expect(prisma.openItem.findUnique({ where: { id: openItemId } })).resolves.toMatchObject({ allocatedAmountCents: 11_900, status: 'SETTLED', version: 3 })
    await expect(prisma.settlementAllocation.count({ where: { ownerId: 'tenant-a', openItemId } })).resolves.toBe(2)
  })

  it('Given tenant-scoped lists, when open items are queried, then another tenant cannot observe documents or allocations', async () => {
    const own = await api.listOpenItems('tenant-a')
    expect(own.length).toBeGreaterThanOrEqual(3)
    expect(own.find(item => item.id === openItemId)).toMatchObject({ id: openItemId, commercialDocument: { id: documentId, businessPartner: { id: partnerId } } })
    await expect(api.listOpenItems('tenant-b')).resolves.toEqual([])
  })

  it('Given a process crash after structured storage, when pending accounting is reconciled, then the orphan is posted exactly once and disappears from the repair queue', async () => {
    const original = await prisma.structuredInvoice.findUniqueOrThrow({ where: { id: 'structured-a' } })
    const data = JSON.parse(original.data) as StructuredInvoiceData
    expect({ currency: data.currency, countryCode: data.buyer.countryCode, reverseCharge: data.reverseCharge ?? false, exemptionReason: data.exemptionReason ?? null, payableAmountCents: data.payableAmountCents ?? data.grossAmountCents - (data.prepaidAmountCents ?? 0) + (data.payableRoundingAmountCents ?? 0), grossAmountCents: data.grossAmountCents }).toEqual({ currency: 'EUR', countryCode: 'DE', reverseCharge: false, exemptionReason: null, payableAmountCents: data.grossAmountCents, grossAmountCents: data.grossAmountCents })
    await prisma.documentRecord.create({ data: { id: 'evidence-structured-orphan', ownerId: 'tenant-a', payload: '{}' } })
    await prisma.structuredInvoice.create({ data: {
      id: 'structured-orphan', ownerId: 'tenant-a', documentId: 'evidence-structured-orphan', syntax: original.syntax,
      kind: 'invoice', direction: 'OUTGOING', issuerKey: original.issuerKey, invoiceNumber: '2026-000099',
      issueDate: new Date('2026-08-20'), structuredHash: 'd'.repeat(64), originalMediaType: original.originalMediaType,
      structuredOriginal: original.structuredOriginal, data: JSON.stringify({ ...data, invoiceNumber: '2026-000099', issueDate: '2026-08-20', supplyDate: '2026-08-20' }),
      provenance: original.provenance, renderedHtml: original.renderedHtml,
    } })
    await prisma.invoiceIssuanceRequest.create({ data: { ownerId: 'tenant-a', requestKey: 'orphan-recovery-request', requestHash: 'e'.repeat(64), status: 'ISSUED', structuredInvoiceId: 'structured-orphan' } })

    const repaired = await api.reconcilePendingOutgoingInvoiceAccounting('tenant-a', 'user-a')
    expect(repaired).toEqual([expect.objectContaining({ structuredInvoiceId: 'structured-orphan', status: 'POSTED', postingJournalEntryId: expect.any(String) })])
    await expect(api.reconcilePendingOutgoingInvoiceAccounting('tenant-a', 'user-a')).resolves.toEqual([])
    await expect(prisma.commercialDocument.count({ where: { ownerId: 'tenant-a', structuredInvoiceId: 'structured-orphan' } })).resolves.toBe(1)
    await expect(prisma.vatPostingRecord.count({ where: { ownerId: 'tenant-a', documentId: 'evidence-structured-orphan' } })).resolves.toBe(1)
  })
})
