import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PrismaClient } from '@/generated/prisma/client'

vi.mock('server-only', () => ({}))
const directory = mkdtempSync(join(tmpdir(), 'accounting-incoming-invoice-'))
const databasePath = join(directory, 'test.db').replace(/\\/g, '/')
let api: typeof import('./incomingInvoicePosting')
let prisma: typeof import('@/server/persistence/client').prisma

const reviewed = (taxAmountCents = 1_900) => JSON.stringify({ supplierName: 'Example Supplier GmbH', invoiceNumber: taxAmountCents === 1_900 ? 'E2E-2026-001' : 'INVALID-VAT', issueDate: '2026-07-23', netAmountCents: 10_000, taxAmountCents, grossAmountCents: 10_000 + taxAmountCents, currency: 'EUR', confidence: { supplierName: 1, invoiceNumber: 1, issueDate: 1, netAmountCents: 1, taxAmountCents: 1, grossAmountCents: 1 }, provenance: 'HUMAN_REVIEW' })

beforeAll(async () => {
  const database = new DatabaseSync(databasePath)
  const migrations = resolve(process.cwd(), 'prisma', 'migrations')
  for (const name of readdirSync(migrations, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort()) database.exec(readFileSync(join(migrations, name, 'migration.sql'), 'utf8'))
  database.close()
  process.env.DATABASE_URL = `file:${databasePath}`
  process.env.AUDIT_INTEGRITY_SECRET = 'incoming-invoice-test-audit-secret-32'
  api = await import('./incomingInvoicePosting')
  prisma = (await import('@/server/persistence/client')).prisma
  await prisma.fiscalYear.createMany({ data: [{ id: 'fy-a', ownerId: 'tenant-a', year: 2026, startsAt: new Date('2026-01-01'), endsAt: new Date('2026-12-31') }, { id: 'fy-b', ownerId: 'tenant-b', year: 2026, startsAt: new Date('2026-01-01'), endsAt: new Date('2026-12-31') }] })
  await prisma.ledgerProfile.createMany({ data: [{ ownerId: 'tenant-a', chart: 'SKR03', accountLength: 4 }, { ownerId: 'tenant-b', chart: 'SKR03', accountLength: 4 }] })
  await prisma.ledgerAccount.createMany({ data: [
    { id: 'depreciation-a', ownerId: 'tenant-a', number: 4830, name: 'Abschreibungen auf Sachanlagen', category: 'EXPENSE', eBilanzPosition: 'is.netIncome.regular.operatingTC.deprAmort.fixAss.tan' },
    { id: 'expense-a', ownerId: 'tenant-a', number: 4930, name: 'Office supplies', category: 'EXPENSE' },
    { id: 'vat-reduced-a', ownerId: 'tenant-a', number: 1571, name: 'Input VAT 7%', category: 'ASSET' },
    { id: 'vat-a', ownerId: 'tenant-a', number: 1576, name: 'Input VAT 19%', category: 'ASSET' },
    { id: 'payables-a', ownerId: 'tenant-a', number: 1600, name: 'Trade payables', category: 'LIABILITY' },
  ] })
  await prisma.documentRecord.createMany({ data: [{ id: 'invoice-a', ownerId: 'tenant-a', payload: '{}' }, { id: 'invalid-a', ownerId: 'tenant-a', payload: '{}' }, { id: 'mixed-a', ownerId: 'tenant-a', payload: '{}' }] })
  await prisma.documentExtraction.createMany({ data: [
    { ownerId: 'tenant-a', documentId: 'invoice-a', status: 'CONFIRMED', provider: 'local-pdf-text', providerVersion: '1', inputHash: 'a'.repeat(64), extractedData: reviewed(), reviewedBy: 'reviewer-a', reviewedAt: new Date('2026-08-04') },
    { ownerId: 'tenant-a', documentId: 'invalid-a', status: 'CONFIRMED', provider: 'local-pdf-text', providerVersion: '1', inputHash: 'b'.repeat(64), extractedData: reviewed(700), reviewedBy: 'reviewer-a', reviewedAt: new Date('2026-08-04') },
    { ownerId: 'tenant-a', documentId: 'mixed-a', status: 'CONFIRMED', provider: 'structured-invoice', providerVersion: 'EN16931-parser-1', inputHash: 'c'.repeat(64), extractedData: JSON.stringify({ supplierName: 'Mixed Supplier GmbH', invoiceNumber: 'UBL-MIXED-1', issueDate: '2026-07-24', netAmountCents: 20_000, taxAmountCents: 2_600, grossAmountCents: 22_600, currency: 'EUR', confidence: {}, provenance: 'STRUCTURED_INVOICE' }), reviewedBy: 'reviewer-a', reviewedAt: new Date('2026-08-04') },
  ] })
  await prisma.structuredInvoice.create({ data: { id: 'structured-mixed-a', ownerId: 'tenant-a', documentId: 'mixed-a', syntax: 'UBL', kind: 'invoice', direction: 'INCOMING', issuerKey: 'mixed-supplier', invoiceNumber: 'UBL-MIXED-1', issueDate: new Date('2026-07-24'), structuredHash: 'c'.repeat(64), originalMediaType: 'application/xml', structuredOriginal: Buffer.from('<Invoice/>'), provenance: '{}', renderedHtml: '<p>invoice</p>', data: JSON.stringify({ syntax: 'UBL', kind: 'invoice', invoiceNumber: 'UBL-MIXED-1', issueDate: '2026-07-24', supplyDate: '2026-07-24', seller: { name: 'Mixed Supplier GmbH', street: 'A 1', city: 'Berlin', postalCode: '10115', countryCode: 'DE', vatId: 'DE123456789' }, buyer: { name: 'Buyer GmbH', street: 'B 2', city: 'Berlin', postalCode: '10115', countryCode: 'DE' }, lines: [{ description: 'Reduced goods', quantity: 1, unitCode: 'C62', netAmountCents: 10_000, taxRateBasisPoints: 700, taxCategoryCode: 'S' }, { description: 'Standard service', quantity: 1, unitCode: 'C62', netAmountCents: 10_000, taxRateBasisPoints: 1900, taxCategoryCode: 'S' }], netAmountCents: 20_000, taxAmountCents: 2_600, grossAmountCents: 22_600, currency: 'EUR' }) } })
})

afterAll(async () => {
  await prisma.$disconnect(); delete process.env.DATABASE_URL; delete process.env.AUDIT_INTEGRITY_SECRET
  rmSync(directory, { recursive: true, force: true })
})

describe('persistent incoming supplier invoice posting', () => {
  it('Given depreciation sorts before office expense, when posting context is loaded, then the persisted chart recommends 4930', async () => {
    await expect(api.getIncomingInvoicePostingContext('tenant-a', 'invoice-a')).resolves.toMatchObject({
      recommendedExpenseAccountId: 'expense-a',
      expenseAccounts: [{ id: 'depreciation-a', number: 4830 }, { id: 'expense-a', number: 4930 }],
    })
  })

  it('Given a confirmed extraction, when posting is explicitly confirmed and retried, then one payable, balanced journal, attachment, and open item persist', async () => {
    const first = await api.postConfirmedIncomingInvoice('tenant-a', 'user-a', 'invoice-a', { expenseAccountId: 'expense-a', dueDate: '2026-08-06', reason: 'Reviewed source invoice and confirmed account assignment' })
    const replay = await api.postConfirmedIncomingInvoice('tenant-a', 'user-a', 'invoice-a', { expenseAccountId: 'expense-a', dueDate: '2026-08-06', reason: 'Safe retry' })
    expect(replay.id).toBe(first.id)
    expect(first).toMatchObject({ direction: 'PAYABLE', kind: 'INVOICE', status: 'POSTED', documentNumber: 'E2E-2026-001', netAmountCents: 10_000, taxAmountCents: 1_900, grossAmountCents: 11_900, businessPartner: { role: 'SUPPLIER', name: 'Example Supplier GmbH' }, openItem: { side: 'CREDIT', status: 'OPEN', originalAmountCents: 11_900 } })
    expect(first.postingJournalEntry!.lines.map(line => ({ number: line.account.number, debit: line.debitCents, credit: line.creditCents, taxCode: line.taxCode }))).toEqual([
      { number: 4930, debit: 10_000, credit: 0, taxCode: 'DE_STANDARD' },
      { number: 1576, debit: 1_900, credit: 0, taxCode: null },
      { number: 1600, debit: 0, credit: 11_900, taxCode: null },
    ])
    expect(first.postingJournalEntry!.documents).toEqual([{ journalEntryId: first.postingJournalEntryId, documentId: 'invoice-a' }])
    await expect(prisma.commercialDocument.count({ where: { ownerId: 'tenant-a' } })).resolves.toBe(1)
    await expect(prisma.journalEntry.count({ where: { ownerId: 'tenant-a' } })).resolves.toBe(1)
    await expect(prisma.openItem.count({ where: { ownerId: 'tenant-a' } })).resolves.toBe(1)
    await expect(prisma.vatPostingRecord.findFirst({ where: { ownerId: 'tenant-a', documentId: 'invoice-a' } })).resolves.toMatchObject({ ruleId: 'DE_STANDARD', netBaseCents: 10_000, inputTaxCents: 1_900 })
    await expect(prisma.auditEvent.findFirst({ where: { ownerId: 'tenant-a', action: 'INCOMING_INVOICE_POSTED' } })).resolves.toBeTruthy()

    const reopened = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${databasePath}` }) })
    await expect(reopened.commercialDocument.findUnique({ where: { id: first.id }, include: { openItem: true, postingJournalEntry: { include: { lines: true, documents: true } } } })).resolves.toMatchObject({ status: 'POSTED', openItem: { originalAmountCents: 11_900 }, postingJournalEntry: { source: 'INCOMING_INVOICE', documents: [{ documentId: 'invoice-a' }] } })
    await reopened.$disconnect()
  })

  it('Given a reviewed mixed-rate structured invoice, when posting is retried, then separate canonical input-VAT records and control accounts persist once', async () => {
    const input = { expenseAccountId: 'expense-a', dueDate: '2026-08-07', reason: 'Reviewed authoritative UBL payable' }
    const first = await api.postConfirmedIncomingInvoice('tenant-a', 'user-a', 'mixed-a', input)
    const replay = await api.postConfirmedIncomingInvoice('tenant-a', 'user-a', 'mixed-a', input)
    expect(replay.id).toBe(first.id)
    expect(first).toMatchObject({ structuredInvoiceId: 'structured-mixed-a', grossAmountCents: 22_600, openItem: { originalAmountCents: 22_600 } })
    expect(first.postingJournalEntry!.lines.map(line => ({ number: line.account.number, debit: line.debitCents, credit: line.creditCents, taxCode: line.taxCode }))).toEqual([
      { number: 4930, debit: 10_000, credit: 0, taxCode: 'DE_REDUCED' }, { number: 4930, debit: 10_000, credit: 0, taxCode: 'DE_STANDARD' },
      { number: 1571, debit: 700, credit: 0, taxCode: null }, { number: 1576, debit: 1_900, credit: 0, taxCode: null }, { number: 1600, debit: 0, credit: 22_600, taxCode: null },
    ])
    await expect(prisma.vatPostingRecord.findMany({ where: { ownerId: 'tenant-a', documentId: 'mixed-a' }, orderBy: { rateBasisPoints: 'asc' } })).resolves.toMatchObject([
      { ruleId: 'DE_REDUCED', rateBasisPoints: 700, netBaseCents: 10_000, inputTaxCents: 700 },
      { ruleId: 'DE_STANDARD', rateBasisPoints: 1900, netBaseCents: 10_000, inputTaxCents: 1_900 },
    ])
  })

  it('Given a reviewed domestic zero-rate structured invoice, when posted, then a zero VAT record, payable, journal and evidence survive reopening without an input-VAT control line', async () => {
    await createStructuredScenario({ ownerId: 'tenant-zero', chart: 'SKR03', documentId: 'zero-doc', invoiceNumber: 'ZERO-UBL-1', lines: [{ description: 'Zero-rated item', quantity: 1, unitCode: 'C62', netAmountCents: 10_000, taxRateBasisPoints: 0, taxCategoryCode: 'Z' }], netAmountCents: 10_000, taxAmountCents: 0, grossAmountCents: 10_000 })
    const posted = await api.postConfirmedIncomingInvoice('tenant-zero', 'user-zero', 'zero-doc', { expenseAccountId: 'tenant-zero-expense', dueDate: '2026-08-08', reason: 'Reviewed zero-rate UBL' })
    expect(posted).toMatchObject({ businessPartner: { name: 'Structured Supplier GmbH' }, openItem: { status: 'OPEN', originalAmountCents: 10_000 }, evidenceDocumentId: 'zero-doc' })
    expect(posted.postingJournalEntry!.lines.map(line => line.account.number)).toEqual([4930, 1600])
    await expect(prisma.vatPostingRecord.findMany({ where: { ownerId: 'tenant-zero', documentId: 'zero-doc' } })).resolves.toMatchObject([{ ruleId: 'DE_ZERO', rateBasisPoints: 0, inputTaxCents: 0, netBaseCents: 10_000 }])
    const reopened = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${databasePath}` }) })
    const durable = await reopened.commercialDocument.findUnique({ where: { id: posted.id }, include: { businessPartner: true, openItem: true, postingJournalEntry: { include: { documents: true, lines: { include: { vatPosting: true } } } } } })
    await reopened.$disconnect()
    expect(durable).toMatchObject({ businessPartner: { name: 'Structured Supplier GmbH' }, openItem: { status: 'OPEN' }, postingJournalEntry: { documents: [{ documentId: 'zero-doc' }] } })
    expect(durable!.postingJournalEntry!.lines).toEqual(expect.arrayContaining([expect.objectContaining({ vatPosting: expect.objectContaining({ ruleId: 'DE_ZERO' }) })]))
  })

  it('Given a reviewed SKR04 mixed 7% and 19% invoice, when posted, then 1401 and 1406 control accounts and both canonical VAT records survive reopening', async () => {
    await createStructuredScenario({ ownerId: 'tenant-skr04', chart: 'SKR04', documentId: 'skr04-doc', invoiceNumber: 'SKR04-MIXED-1', lines: [{ description: 'Reduced', quantity: 1, unitCode: 'C62', netAmountCents: 10_000, taxRateBasisPoints: 700, taxCategoryCode: 'S' }, { description: 'Standard', quantity: 1, unitCode: 'C62', netAmountCents: 10_000, taxRateBasisPoints: 1900, taxCategoryCode: 'S' }], netAmountCents: 20_000, taxAmountCents: 2_600, grossAmountCents: 22_600 })
    const posted = await api.postConfirmedIncomingInvoice('tenant-skr04', 'user-skr04', 'skr04-doc', { expenseAccountId: 'tenant-skr04-expense', dueDate: '2026-08-08', reason: 'Reviewed SKR04 mixed UBL' })
    expect(posted).toMatchObject({ businessPartner: { name: 'Structured Supplier GmbH' }, openItem: { status: 'OPEN', originalAmountCents: 22_600 }, evidenceDocumentId: 'skr04-doc' })
    expect(posted.postingJournalEntry!.lines.map(line => line.account.number)).toEqual([6815, 6815, 1401, 1406, 3300])
    await expect(prisma.vatPostingRecord.findMany({ where: { ownerId: 'tenant-skr04', documentId: 'skr04-doc' }, orderBy: { rateBasisPoints: 'asc' } })).resolves.toMatchObject([{ ruleId: 'DE_REDUCED', inputTaxCents: 700 }, { ruleId: 'DE_STANDARD', inputTaxCents: 1_900 }])
    const reopened = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${databasePath}` }) })
    const durable = await reopened.commercialDocument.findUnique({ where: { id: posted.id }, include: { businessPartner: true, openItem: true, postingJournalEntry: { include: { documents: true, lines: { include: { account: true, vatPosting: true } } } } } })
    await reopened.$disconnect()
    expect(durable).toMatchObject({ businessPartner: { name: 'Structured Supplier GmbH' }, openItem: { status: 'OPEN' }, postingJournalEntry: { documents: [{ documentId: 'skr04-doc' }] } })
    expect(durable!.postingJournalEntry!.lines).toEqual(expect.arrayContaining([expect.objectContaining({ account: expect.objectContaining({ number: 1401 }) }), expect.objectContaining({ account: expect.objectContaining({ number: 1406 }) }), expect.objectContaining({ vatPosting: expect.objectContaining({ ruleId: 'DE_REDUCED' }) }), expect.objectContaining({ vatPosting: expect.objectContaining({ ruleId: 'DE_STANDARD' }) })]))
  })

  it.each([
    { chart: 'SKR03' as const, ownerId: 'tenant-13b-03', documentId: 'rc-03', expense: 4930, payable: 1600, input: 1577, output: 1787 },
    { chart: 'SKR04' as const, ownerId: 'tenant-13b-04', documentId: 'rc-04', expense: 6815, payable: 3300, input: 1407, output: 3837 },
  ])('Given explicit $chart §13b controls and an authoritative domestic AE invoice, when 19% is confirmed, then supplier gross stays net while balanced self-assessment and canonical return evidence persist', async scenario => {
    await createReverseChargeScenario(scenario)
    await expect(api.getIncomingInvoicePostingContext(scenario.ownerId, scenario.documentId)).resolves.toMatchObject({ reverseChargeTreatment: { kind: 'DE_13B_DOMESTIC', configured: true } })
    const input = { expenseAccountId: `${scenario.ownerId}-expense`, dueDate: '2026-08-09', reason: 'Confirmed domestic §13b UStG treatment and 19% assessment', reverseChargeRateBasisPoints: 1900 }
    const first = await api.postConfirmedIncomingInvoice(scenario.ownerId, `${scenario.ownerId}-user`, scenario.documentId, input)
    const replay = await api.postConfirmedIncomingInvoice(scenario.ownerId, `${scenario.ownerId}-user`, scenario.documentId, input)

    expect(replay.id).toBe(first.id)
    expect(first).toMatchObject({ netAmountCents: 10_000, taxAmountCents: 0, grossAmountCents: 10_000, structuredInvoiceId: `${scenario.documentId}-structured`, openItem: { originalAmountCents: 10_000, status: 'OPEN' } })
    expect(first.postingJournalEntry!.lines.map(line => ({ number: line.account.number, debit: line.debitCents, credit: line.creditCents, taxCode: line.taxCode }))).toEqual([
      { number: scenario.expense, debit: 10_000, credit: 0, taxCode: 'DE_13B' },
      { number: scenario.input, debit: 1_900, credit: 0, taxCode: null },
      { number: scenario.output, debit: 0, credit: 1_900, taxCode: null },
      { number: scenario.payable, debit: 0, credit: 10_000, taxCode: null },
    ])
    const record = await prisma.vatPostingRecord.findFirstOrThrow({ where: { ownerId: scenario.ownerId, documentId: scenario.documentId } })
    expect(record).toMatchObject({ ruleId: 'DE_13B', vatCase: 'reverse-charge', rateBasisPoints: 1900, netBaseCents: 10_000, taxCents: 1_900, deductibleTaxCents: 1_900, outputTaxCents: 1_900, inputTaxCents: 1_900, grossCents: 10_000 })
    expect(JSON.parse(record.returnBoxes)).toEqual([
      { box: '84', direction: 'purchase', value: 'net-base' },
      { box: '85', direction: 'purchase', value: 'output-tax' },
      { box: '67', direction: 'purchase', value: 'input-tax' },
    ])
    await expect(prisma.journalEntry.count({ where: { ownerId: scenario.ownerId, source: 'INCOMING_INVOICE' } })).resolves.toBe(1)
    await expect(prisma.vatPostingRecord.count({ where: { ownerId: scenario.ownerId, documentId: scenario.documentId } })).resolves.toBe(1)
    await expect(prisma.journalDocumentAttachment.findFirst({ where: { documentId: scenario.documentId } })).resolves.toMatchObject({ documentId: scenario.documentId })
  })

  it('Given domestic §13b evidence but no exact active-chart configuration or no explicit 19% choice, when posting is attempted, then the transaction fails closed without accounting residue', async () => {
    await createReverseChargeScenario({ chart: 'SKR03', ownerId: 'tenant-13b-missing', documentId: 'rc-missing', expense: 4930, payable: 1600, input: 1577, output: 1787, configured: false })
    await expect(api.getIncomingInvoicePostingContext('tenant-13b-missing', 'rc-missing')).resolves.toMatchObject({ reverseChargeTreatment: { configured: false } })
    await expect(api.postConfirmedIncomingInvoice('tenant-13b-missing', 'user', 'rc-missing', { expenseAccountId: 'tenant-13b-missing-expense', dueDate: '2026-08-09', reason: 'No assessment choice' })).rejects.toThrow(/19%/i)
    await expect(api.postConfirmedIncomingInvoice('tenant-13b-missing', 'user', 'rc-missing', { expenseAccountId: 'tenant-13b-missing-expense', dueDate: '2026-08-09', reason: 'No configured controls', reverseChargeRateBasisPoints: 1900 })).rejects.toThrow(/control accounts/i)
    await expect(api.postConfirmedIncomingInvoice('tenant-b', 'user-b', 'rc-missing', { expenseAccountId: 'tenant-13b-missing-expense', dueDate: '2026-08-09', reason: 'Wrong tenant', reverseChargeRateBasisPoints: 1900 })).rejects.toThrow(/confirmed/i)
    await expect(prisma.commercialDocument.count({ where: { evidenceDocumentId: 'rc-missing' } })).resolves.toBe(0)
    await expect(prisma.journalEntry.count({ where: { ownerId: 'tenant-13b-missing' } })).resolves.toBe(0)
    await expect(prisma.vatPostingRecord.count({ where: { documentId: 'rc-missing' } })).resolves.toBe(0)
  })

  it('Given an Austrian B2B service invoice and explicit active-chart controls, when 19% is confirmed and retried, then net payable, balanced recipient VAT, KZ 46/47/67 provenance, evidence, audit, and tenant isolation persist once', async () => {
    const scenario = { chart: 'SKR03' as const, ownerId: 'tenant-eu-service', documentId: 'eu-service-doc', expense: 4930, payable: 1600, input: 1577, output: 1787, euService: true, issueDate: '2026-07-31', supplyDate: '2026-08-01' }
    await createReverseChargeScenario(scenario)
    await expect(api.getIncomingInvoicePostingContext(scenario.ownerId, scenario.documentId)).resolves.toMatchObject({ reverseChargeTreatment: { kind: 'DE_13B_EU_SERVICE', configured: true } })
    const command = { expenseAccountId: `${scenario.ownerId}-expense`, dueDate: '2026-08-09', reason: 'Confirmed Austrian B2B service under §13b(1) and Article 196 at 19%', reverseChargeRateBasisPoints: 1900, reverseChargeSupplyKind: 'SERVICE' as const }
    const first = await api.postConfirmedIncomingInvoice(scenario.ownerId, 'actor-eu', scenario.documentId, command)
    await expect(api.postConfirmedIncomingInvoice(scenario.ownerId, 'actor-eu', scenario.documentId, command)).resolves.toMatchObject({ id: first.id })
    await expect(api.postConfirmedIncomingInvoice(scenario.ownerId, 'actor-eu', scenario.documentId, { ...command, reverseChargeSupplyKind: undefined })).rejects.toThrow(/exact replay/)
    for (const changed of [{ ...command, reverseChargeRateBasisPoints: 700 }, { ...command, expenseAccountId: 'changed-expense' }, { ...command, dueDate: '2026-08-10' }, { ...command, reason: 'Changed reason' }]) await expect(api.postConfirmedIncomingInvoice(scenario.ownerId, 'actor-eu', scenario.documentId, changed as typeof command)).rejects.toThrow(/exact replay/)
    expect(first).toMatchObject({ issueDate: new Date('2026-07-31'), serviceDate: new Date('2026-08-01'), netAmountCents: 10_000, taxAmountCents: 0, grossAmountCents: 10_000, payableAmountCents: 10_000, businessPartner: { name: 'Vienna Cloud GmbH', vatId: 'ATU12345678', street: 'Ring 1', postalCode: '1010', city: 'Wien', countryCode: 'AT' }, openItem: { originalAmountCents: 10_000, status: 'OPEN' } })
    expect(first.postingJournalEntry!.lines.map(line => ({ number: line.account.number, debit: line.debitCents, credit: line.creditCents, taxCode: line.taxCode }))).toEqual([
      { number: 4930, debit: 10_000, credit: 0, taxCode: 'EU_13B_SERVICE_RECIPIENT' }, { number: 1577, debit: 1_900, credit: 0, taxCode: null },
      { number: 1787, debit: 0, credit: 1_900, taxCode: null }, { number: 1600, debit: 0, credit: 10_000, taxCode: null },
    ])
    const vat = await prisma.vatPostingRecord.findFirstOrThrow({ where: { ownerId: scenario.ownerId, documentId: scenario.documentId } })
    expect(vat).toMatchObject({ ruleId: 'EU_13B_SERVICE_RECIPIENT', vatCase: 'reverse-charge', taxPoint: new Date('2026-08-01'), netBaseCents: 10_000, outputTaxCents: 1_900, inputTaxCents: 1_900, documentId: scenario.documentId })
    expect(JSON.parse(vat.returnBoxes)).toEqual([{ box: '46', direction: 'purchase', value: 'net-base' }, { box: '47', direction: 'purchase', value: 'output-tax' }, { box: '67', direction: 'purchase', value: 'input-tax' }])
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { ownerId: scenario.ownerId, actorId: 'actor-eu', action: 'INCOMING_INVOICE_POSTED' } })
    expect(JSON.parse(audit.semanticDelta).after).toMatchObject({ reverseChargeSupplyKind: 'SERVICE', supplyDate: '2026-08-01', tenantBuyerVatId: 'DE987654321', supplierVatId: 'ATU12345678', vatRuleIds: ['EU_13B_SERVICE_RECIPIENT'] })
    expect(first.postingJournalEntry!.bookingDate).toEqual(new Date('2026-08-01'))
    await expect(api.postConfirmedIncomingInvoice('tenant-b', 'actor-b', scenario.documentId, command)).rejects.toThrow(/confirmed/i)
    await expect(prisma.journalEntry.count({ where: { ownerId: scenario.ownerId, source: 'INCOMING_INVOICE' } })).resolves.toBe(1)
    const reopened = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${databasePath}` }) })
    await expect(reopened.commercialDocument.findUnique({ where: { id: first.id }, include: { openItem: true, postingJournalEntry: { include: { documents: true, lines: { include: { vatPosting: true } } } } } })).resolves.toMatchObject({ openItem: { originalAmountCents: 10_000 }, postingJournalEntry: { documents: [{ documentId: scenario.documentId }] } })
    await reopened.$disconnect()
  })

  it('Given an EU invoice buyer VAT ID that differs from the tenant company profile, when posting is attempted, then no partner, journal, VAT, payable, or audit residue is created', async () => {
    await createReverseChargeScenario({ chart: 'SKR03', ownerId: 'tenant-eu-buyer-mismatch', documentId: 'eu-buyer-mismatch', expense: 4930, payable: 1600, input: 1577, output: 1787, euService: true, tenantVatId: 'DE123456789' })
    await expect(api.postConfirmedIncomingInvoice('tenant-eu-buyer-mismatch', 'actor', 'eu-buyer-mismatch', { expenseAccountId: 'tenant-eu-buyer-mismatch-expense', dueDate: '2026-08-09', reason: 'Should fail', reverseChargeRateBasisPoints: 1900, reverseChargeSupplyKind: 'SERVICE' })).rejects.toThrow(/exactly match.*tenant/i)
    await expect(prisma.businessPartner.count({ where: { ownerId: 'tenant-eu-buyer-mismatch' } })).resolves.toBe(0)
    await expect(prisma.journalEntry.count({ where: { ownerId: 'tenant-eu-buyer-mismatch' } })).resolves.toBe(0)
    await expect(prisma.commercialDocument.count({ where: { ownerId: 'tenant-eu-buyer-mismatch' } })).resolves.toBe(0)
    await expect(prisma.vatPostingRecord.count({ where: { ownerId: 'tenant-eu-buyer-mismatch' } })).resolves.toBe(0)
    await expect(prisma.auditEvent.count({ where: { ownerId: 'tenant-eu-buyer-mismatch' } })).resolves.toBe(0)
  })

  it('Given an EU service invoice without an exact supply date, when posting is attempted, then tax-point selection fails before accounting residue', async () => {
    const ownerId = 'tenant-eu-missing-supply'; const documentId = 'eu-missing-supply'
    await createReverseChargeScenario({ chart: 'SKR03', ownerId, documentId, expense: 4930, payable: 1600, input: 1577, output: 1787, euService: true, supplyDate: '' })
    await expect(api.postConfirmedIncomingInvoice(ownerId, 'actor', documentId, { expenseAccountId: `${ownerId}-expense`, dueDate: '2026-08-09', reason: 'Must fail without service date', reverseChargeRateBasisPoints: 1900, reverseChargeSupplyKind: 'SERVICE' })).rejects.toThrow(/supply date/i)
    await expect(prisma.businessPartner.count({ where: { ownerId } })).resolves.toBe(0)
    await expect(prisma.journalEntry.count({ where: { ownerId } })).resolves.toBe(0)
    await expect(prisma.vatPostingRecord.count({ where: { ownerId } })).resolves.toBe(0)
  })

  it('Given supplier spelling changes and distinct VAT IDs, when EU service invoices post, then VAT identity reuses the former supplier and separates the latter despite the same name', async () => {
    const ownerId = 'tenant-eu-supplier-identity'
    const base = { chart: 'SKR03' as const, ownerId, expense: 4930, payable: 1600, input: 1577, output: 1787, euService: true }
    await createReverseChargeScenario({ ...base, documentId: 'eu-id-1', invoiceNumber: 'EU-ID-1', sellerName: 'Vienna Cloud GmbH' })
    await createReverseChargeScenario({ ...base, documentId: 'eu-id-2', invoiceNumber: 'EU-ID-2', sellerName: 'VIENNA CLOUD GMBH', reuseSetup: true })
    await createReverseChargeScenario({ ...base, documentId: 'eu-id-3', invoiceNumber: 'EU-ID-3', sellerName: 'VIENNA CLOUD GMBH', sellerVatId: 'ATU87654321', reuseSetup: true })
    await createReverseChargeScenario({ ...base, documentId: 'eu-id-duplicate', invoiceNumber: 'EU-ID-1', sellerName: 'Vienna Cloud G.m.b.H.', reuseSetup: true })
    const command = { expenseAccountId: `${ownerId}-expense`, dueDate: '2026-08-09', reason: 'Confirmed exact supplier VAT identity', reverseChargeRateBasisPoints: 1900, reverseChargeSupplyKind: 'SERVICE' as const }
    const first = await api.postConfirmedIncomingInvoice(ownerId, 'actor', 'eu-id-1', command)
    const spelling = await api.postConfirmedIncomingInvoice(ownerId, 'actor', 'eu-id-2', command)
    const distinct = await api.postConfirmedIncomingInvoice(ownerId, 'actor', 'eu-id-3', command)
    await expect(api.postConfirmedIncomingInvoice(ownerId, 'actor', 'eu-id-duplicate', command)).rejects.toThrow(/already been posted/)
    expect(spelling.businessPartnerId).toBe(first.businessPartnerId)
    expect(distinct.businessPartnerId).not.toBe(first.businessPartnerId)
    await expect(prisma.businessPartner.count({ where: { ownerId } })).resolves.toBe(2)
    await expect(prisma.commercialDocument.count({ where: { ownerId } })).resolves.toBe(3)
    expect(JSON.parse(spelling.counterpartySnapshot!)).toMatchObject({ name: 'VIENNA CLOUD GMBH', vatId: 'ATU12345678', street: 'Ring 1', postalCode: '1010', city: 'Wien', countryCode: 'AT' })
  })

  it('Given concurrent EU-service commands with different canonical facts, when they race, then only one exact command can win and the other cannot receive its posting', async () => {
    const ownerId = 'tenant-eu-command-race'; const documentId = 'eu-command-race'
    await createReverseChargeScenario({ chart: 'SKR03', ownerId, documentId, expense: 4930, payable: 1600, input: 1577, output: 1787, euService: true })
    const common = { expenseAccountId: `${ownerId}-expense`, dueDate: '2026-08-09', reverseChargeRateBasisPoints: 1900, reverseChargeSupplyKind: 'SERVICE' as const }
    const results = await Promise.allSettled([api.postConfirmedIncomingInvoice(ownerId, 'actor-a', documentId, { ...common, reason: 'Command A' }), api.postConfirmedIncomingInvoice(ownerId, 'actor-b', documentId, { ...common, reason: 'Command B' })])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    await expect(prisma.journalEntry.count({ where: { ownerId } })).resolves.toBe(1)
    await expect(prisma.commercialDocument.count({ where: { ownerId } })).resolves.toBe(1)
  })

  it('Given another tenant or unsupported VAT, when posting is attempted, then no accounting rows are written', async () => {
    await expect(api.postConfirmedIncomingInvoice('tenant-b', 'user-b', 'invoice-a', { expenseAccountId: 'expense-a', dueDate: '2026-08-06', reason: 'Wrong tenant' })).rejects.toThrow(/confirmed/i)
    await expect(api.postConfirmedIncomingInvoice('tenant-a', 'user-a', 'invalid-a', { expenseAccountId: 'expense-a', dueDate: '2026-08-06', reason: 'Unsupported VAT' })).rejects.toThrow(/19%/)
    await expect(prisma.commercialDocument.count({ where: { evidenceDocumentId: 'invalid-a' } })).resolves.toBe(0)
    await expect(prisma.journalDocumentAttachment.count({ where: { documentId: 'invalid-a' } })).resolves.toBe(0)
  })
})

async function createStructuredScenario(input: { ownerId: string; chart: 'SKR03' | 'SKR04'; documentId: string; invoiceNumber: string; lines: Array<{ description: string; quantity: number; unitCode: string; netAmountCents: number; taxRateBasisPoints: number; taxCategoryCode: string }>; netAmountCents: number; taxAmountCents: number; grossAmountCents: number }) {
  await prisma.fiscalYear.create({ data: { id: `${input.ownerId}-fy`, ownerId: input.ownerId, year: 2026, startsAt: new Date('2026-01-01'), endsAt: new Date('2026-12-31') } })
  await prisma.ledgerProfile.create({ data: { ownerId: input.ownerId, chart: input.chart, accountLength: 4 } })
  const skr04 = input.chart === 'SKR04'
  await prisma.ledgerAccount.createMany({ data: [
    { id: `${input.ownerId}-expense`, ownerId: input.ownerId, number: skr04 ? 6815 : 4930, name: 'Office expense', category: 'EXPENSE', eBilanzPosition: 'is.netIncome.regular.operatingTC.otherCost' },
    { id: `${input.ownerId}-payables`, ownerId: input.ownerId, number: skr04 ? 3300 : 1600, name: 'Trade payables', category: 'LIABILITY' },
    ...(input.lines.some(line => line.taxRateBasisPoints === 700) ? [{ id: `${input.ownerId}-vat7`, ownerId: input.ownerId, number: skr04 ? 1401 : 1571, name: 'Input VAT 7%', category: 'ASSET' }] : []),
    ...(input.lines.some(line => line.taxRateBasisPoints === 1900) ? [{ id: `${input.ownerId}-vat19`, ownerId: input.ownerId, number: skr04 ? 1406 : 1576, name: 'Input VAT 19%', category: 'ASSET' }] : []),
  ] })
  const data = { syntax: 'UBL', kind: 'invoice', invoiceNumber: input.invoiceNumber, issueDate: '2026-07-25', supplyDate: '2026-07-25', seller: { name: 'Structured Supplier GmbH', street: 'A 1', city: 'Berlin', postalCode: '10115', countryCode: 'DE', vatId: 'DE123456789' }, buyer: { name: 'Buyer GmbH', street: 'B 2', city: 'Berlin', postalCode: '10115', countryCode: 'DE' }, lines: input.lines, netAmountCents: input.netAmountCents, taxAmountCents: input.taxAmountCents, grossAmountCents: input.grossAmountCents, currency: 'EUR' }
  await prisma.documentRecord.create({ data: { id: input.documentId, ownerId: input.ownerId, payload: '{}' } })
  await prisma.documentExtraction.create({ data: { ownerId: input.ownerId, documentId: input.documentId, status: 'CONFIRMED', provider: 'structured-invoice', providerVersion: 'EN16931-parser-1', inputHash: input.ownerId.padEnd(64, 'x').slice(0, 64), extractedData: JSON.stringify({ supplierName: data.seller.name, invoiceNumber: data.invoiceNumber, issueDate: data.issueDate, netAmountCents: data.netAmountCents, taxAmountCents: data.taxAmountCents, grossAmountCents: data.grossAmountCents, currency: 'EUR', confidence: {}, provenance: 'STRUCTURED_INVOICE' }), reviewedBy: 'reviewer', reviewedAt: new Date('2026-08-04') } })
  await prisma.structuredInvoice.create({ data: { ownerId: input.ownerId, documentId: input.documentId, syntax: 'UBL', kind: 'invoice', direction: 'INCOMING', issuerKey: `${input.ownerId}-issuer`, invoiceNumber: input.invoiceNumber, issueDate: new Date('2026-07-25'), structuredHash: input.ownerId.padEnd(64, 'y').slice(0, 64), originalMediaType: 'application/xml', structuredOriginal: Buffer.from('<Invoice/>'), provenance: '{}', renderedHtml: '<p>invoice</p>', data: JSON.stringify(data) } })
}

async function createReverseChargeScenario(input: { ownerId: string; chart: 'SKR03' | 'SKR04'; documentId: string; expense: number; payable: number; input: number; output: number; configured?: boolean; euService?: boolean; issueDate?: string; supplyDate?: string; sellerName?: string; sellerVatId?: string; invoiceNumber?: string; tenantVatId?: string; reuseSetup?: boolean }) {
  if (!input.reuseSetup) {
    await prisma.fiscalYear.create({ data: { id: `${input.ownerId}-fy`, ownerId: input.ownerId, year: 2026, startsAt: new Date('2026-01-01'), endsAt: new Date('2026-12-31') } })
    await prisma.ledgerProfile.create({ data: { ownerId: input.ownerId, chart: input.chart, accountLength: 4 } })
    await prisma.ledgerAccount.createMany({ data: [
    { id: `${input.ownerId}-expense`, ownerId: input.ownerId, number: input.expense, name: 'Operating expense', category: 'EXPENSE' },
    { id: `${input.ownerId}-payable`, ownerId: input.ownerId, number: input.payable, name: 'Trade payables', category: 'LIABILITY' },
    { id: `${input.ownerId}-rc-input`, ownerId: input.ownerId, number: input.input, name: 'Input VAT §13b 19%', category: 'ASSET' },
    { id: `${input.ownerId}-rc-output`, ownerId: input.ownerId, number: input.output, name: 'Output VAT §13b 19%', category: 'LIABILITY' },
    ] })
    if (input.configured !== false) await prisma.accountRecord.create({ data: { id: `company:${input.ownerId}`, ownerId: input.ownerId, payload: JSON.stringify({ incomingReverseChargeAccounts: { chart: input.chart, rateBasisPoints: 1900, inputVatAccountNumber: input.input, outputVatAccountNumber: input.output }, ...(input.euService ? { companyProfile: { vatId: input.tenantVatId ?? 'DE987654321' } } : {}) }) } })
  }
  const data = { syntax: 'UBL', kind: 'invoice', invoiceNumber: input.invoiceNumber ?? (input.euService ? 'EU-SVC-AT-1' : `RC-${input.chart}`), issueDate: input.issueDate ?? '2026-07-26', supplyDate: input.supplyDate ?? '2026-07-26', seller: input.euService ? { name: input.sellerName ?? 'Vienna Cloud GmbH', street: 'Ring 1', city: 'Wien', postalCode: '1010', countryCode: 'AT', vatId: input.sellerVatId ?? 'ATU12345678' } : { name: 'German Construction Supplier GmbH', street: 'A 1', city: 'Berlin', postalCode: '10115', countryCode: 'DE', vatId: 'DE123456789' }, buyer: { name: 'Buyer GmbH', street: 'B 2', city: 'Berlin', postalCode: '10115', countryCode: 'DE', vatId: 'DE987654321' }, lines: [{ description: input.euService ? 'Cloud service' : 'Domestic construction service', quantity: 1, unitCode: 'C62', netAmountCents: 10_000, taxRateBasisPoints: 0, taxCategoryCode: 'AE', exemptionReason: input.euService ? 'Reverse charge - Article 196 VAT Directive' : 'Steuerschuldnerschaft des Leistungsempfängers gemäß § 13b UStG', reverseCharge: true }], netAmountCents: 10_000, taxAmountCents: 0, grossAmountCents: 10_000, payableAmountCents: 10_000, currency: 'EUR', reverseCharge: true }
  await prisma.documentRecord.create({ data: { id: input.documentId, ownerId: input.ownerId, payload: '{}' } })
  await prisma.documentExtraction.create({ data: { ownerId: input.ownerId, documentId: input.documentId, status: 'CONFIRMED', provider: 'structured-invoice', providerVersion: 'EN16931-parser-1', inputHash: input.ownerId.padEnd(64, 'r').slice(0, 64), extractedData: JSON.stringify({ supplierName: data.seller.name, invoiceNumber: data.invoiceNumber, issueDate: data.issueDate, netAmountCents: 10_000, taxAmountCents: 0, grossAmountCents: 10_000, currency: 'EUR', confidence: {}, provenance: 'STRUCTURED_INVOICE' }), reviewedBy: 'reviewer', reviewedAt: new Date('2026-08-04') } })
  await prisma.structuredInvoice.create({ data: { id: `${input.documentId}-structured`, ownerId: input.ownerId, documentId: input.documentId, syntax: 'UBL', kind: 'invoice', direction: 'INCOMING', issuerKey: `${input.ownerId}:${input.documentId}:issuer`, invoiceNumber: data.invoiceNumber, issueDate: new Date(data.issueDate), structuredHash: createHashForTest(input.ownerId, input.documentId), originalMediaType: 'application/xml', structuredOriginal: Buffer.from('<Invoice/>'), provenance: '{}', renderedHtml: '<p>§13b invoice</p>', data: JSON.stringify(data) } })
}

function createHashForTest(ownerId: string, documentId: string) { return `${ownerId}:${documentId}`.padEnd(64, 's').slice(0, 64) }
