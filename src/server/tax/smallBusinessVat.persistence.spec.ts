import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { SMALL_BUSINESS_NOTICE } from '@/core/smallBusinessVat'
import type { StructuredInvoiceData } from '@/core/eInvoice'
import { seedChart } from '@/server/compliance/chartLifecycle'

vi.mock('server-only', () => ({}))
const directory = mkdtempSync(join(tmpdir(), 'accounting-small-business-'))
let prisma: typeof import('@/server/persistence/client').prisma
let commercial: typeof import('@/server/commercialAccountingRepository')
let incoming: typeof import('@/server/incomingInvoicePosting')
let vat: typeof import('./vatRepository')
let profiles: typeof import('./companyVatProfile')

beforeAll(async () => {
  const databasePath = join(directory, 'test.db')
  const db = new DatabaseSync(databasePath)
  const migrations = resolve('prisma/migrations')
  for (const name of readdirSync(migrations, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()) db.exec(readFileSync(join(migrations, name, 'migration.sql'), 'utf8'))
  db.close()
  process.env.DATABASE_URL = `file:${databasePath.replaceAll('\\', '/')}`
  process.env.AUDIT_INTEGRITY_SECRET = 'synthetic-small-business-audit-key-28'
  prisma = (await import('@/server/persistence/client')).prisma
  commercial = await import('@/server/commercialAccountingRepository')
  incoming = await import('@/server/incomingInvoicePosting')
  vat = await import('./vatRepository')
  profiles = await import('./companyVatProfile')
}, 60_000)

afterAll(async () => { await prisma?.$disconnect(); rmSync(directory, { recursive: true, force: true }) })

const profile = (chart = 'SKR03', legalForm = 'UG', vatRegime = 'SMALL_BUSINESS') => ({ companyName: 'Synthetic company', legalForm, taxNumber: '12/345/67890', taxOffice: 'Berlin', vatRegime, vatFilingFrequency: 'ANNUAL', activity: 'Consulting', sizeClass: 'MICRO', chart, elections: [] })
async function tenant(id: string, chart = 'SKR03', legalForm = 'UG') {
  await prisma.companyProfileVersion.create({ data: { ownerId: id, effectiveFrom: new Date('2026-01-01'), payload: JSON.stringify(profile(chart, legalForm)), createdBy: 'tester', reason: 'Synthetic confirmed §19 profile' } })
  await prisma.ledgerProfile.create({ data: { ownerId: id, chart, accountLength: 4 } })
  await prisma.fiscalYear.create({ data: { id, ownerId: id, year: 2026, startsAt: new Date('2026-01-01'), endsAt: new Date('2026-12-31') } })
  await prisma.ledgerAccount.createMany({ data: seedChart(chart).filter(account => !['1571', '1576', '1401', '1406', '1771', '1776', '3801', '3806'].includes(String(account.accountNumber))).map(account => ({ ownerId: id, number: account.accountNumber, name: account.name, category: account.accountType })) })
}

function invoice(number: string, issueDate = '2026-05-01'): StructuredInvoiceData {
  return { syntax: 'UBL', kind: 'invoice', invoiceNumber: number, issueDate, supplyDate: issueDate, seller: { name: 'Synthetic company', street: 'Test 1', postalCode: '10115', city: 'Berlin', countryCode: 'DE', taxId: '12/345/67890' }, buyer: { name: 'Synthetic buyer', street: 'Test 2', postalCode: '10115', city: 'Berlin', countryCode: 'DE' }, lines: [{ description: 'Consulting', quantity: 1, unitCode: 'C62', netAmountCents: 10_000, taxRateBasisPoints: 0, taxCategoryCode: 'E', exemptionReason: SMALL_BUSINESS_NOTICE }], exemptionReason: SMALL_BUSINESS_NOTICE, netAmountCents: 10_000, taxAmountCents: 0, grossAmountCents: 10_000, currency: 'EUR' }
}

async function retained(ownerId: string, id: string, data: StructuredInvoiceData, direction = 'OUTGOING', correctsId?: string) {
  await prisma.documentRecord.create({ data: { id, ownerId, payload: '{}' } })
  return prisma.structuredInvoice.create({ data: { id, ownerId, documentId: id, syntax: 'UBL', kind: data.kind, direction, issuerKey: ownerId, invoiceNumber: data.invoiceNumber, issueDate: new Date(data.issueDate), structuredHash: id.padEnd(64, 'a'), originalMediaType: 'application/xml', structuredOriginal: Buffer.from('<synthetic/>'), data: JSON.stringify(data), provenance: '{}', renderedHtml: '<p>Synthetic fixture</p>', correctsId } })
}

describe('persisted Kleinunternehmer accounting', () => {
  test.each([['SKR03', 'UG', 8192], ['SKR04', 'SOLE_TRADER', 4184]])('Given a %s %s profile, when an exempt invoice is posted and retried, then a balanced receivable uses account %s without VAT controls', async (chart, legalForm, revenue) => {
    const owner = `sale-${chart}`; await tenant(owner, chart, legalForm)
    const data = invoice(owner); await commercial.preflightOutgoingStructuredInvoiceAccounting(owner, data)
    await retained(owner, owner, data)
    const posted = await commercial.registerOutgoingStructuredInvoice(owner, 'tester', owner)
    expect((await commercial.registerOutgoingStructuredInvoice(owner, 'tester', owner)).id).toBe(posted.id)
    const lines = await prisma.journalLine.findMany({ where: { journalEntryId: posted.postingJournalEntryId! }, include: { account: true } })
    expect(lines).toHaveLength(2)
    expect(lines.find(line => line.account.number === revenue)).toMatchObject({ creditCents: 10_000, taxAmountCents: 0, taxCode: 'DE_SMALL_BUSINESS' })
    expect(lines.reduce((sum, line) => sum + line.debitCents - line.creditCents, 0)).toBe(0)
    expect(posted.openItem?.originalAmountCents).toBe(10_000)
    await expect(vat.prepareReconciledAnnualVatDataset(owner, 2026)).rejects.toThrow(/normally exempt/)
  })

  test('Given a taxable supplier invoice, when a small business posts it, then supplier VAT is retained as expense with no deductible input tax', async () => {
    const owner = 'purchase'; await tenant(owner)
    await prisma.documentRecord.create({ data: { id: owner, ownerId: owner, payload: '{}' } })
    const facts = { supplierName: 'Supplier', invoiceNumber: 'SUP-1', issueDate: '2026-05-01', netAmountCents: 10_000, taxAmountCents: 1900, grossAmountCents: 11900, currency: 'EUR', confidence: {}, provenance: 'HUMAN_REVIEW' }
    await prisma.documentExtraction.create({ data: { ownerId: owner, documentId: owner, status: 'CONFIRMED', provider: 'synthetic', providerVersion: '1', inputHash: 'a'.repeat(64), extractedData: JSON.stringify(facts), reviewedBy: 'tester', reviewedAt: new Date() } })
    const expense = await prisma.ledgerAccount.findFirstOrThrow({ where: { ownerId: owner, number: 4930 } })
    const posted = await incoming.postConfirmedIncomingInvoice(owner, 'tester', owner, { expenseAccountId: expense.id, dueDate: '2026-05-15', reason: 'Reviewed synthetic purchase' })
    expect(posted.postingJournalEntry!.lines).toHaveLength(2)
    expect(posted.postingJournalEntry!.lines.find(line => line.account.number === 4930)).toMatchObject({ debitCents: 11900, taxAmountCents: 1900, deductibleTaxCents: 0 })
    expect(posted.taxAmountCents).toBe(1900)
    await expect(prisma.vatPostingRecord.findFirst({ where: { ownerId: owner } })).resolves.toMatchObject({ ruleId: 'DE_STANDARD_NO_INPUT_VAT', taxCents: 1900, deductibleTaxCents: 0, inputTaxCents: 0 })
  })

  test('Given a reverse-charge purchase, when posted by a small business, then tax remains payable without an offsetting deduction', async () => {
    const owner = 'reverse-charge'; await tenant(owner)
    await prisma.accountRecord.create({ data: { id: owner, ownerId: owner, payload: JSON.stringify({ incomingReverseChargeAccounts: { chart: 'SKR03', rateBasisPoints: 1900, inputVatAccountNumber: 1577, outputVatAccountNumber: 1787 } }) } })
    await prisma.ledgerAccount.create({ data: { ownerId: owner, number: 1787, name: 'Recipient VAT', category: 'LIABILITY' } })
    const data = invoice('RC-1'); data.exemptionReason = undefined; data.reverseCharge = true; data.lines = [{ ...data.lines[0], taxCategoryCode: 'AE', exemptionReason: 'Steuerschuldnerschaft des Leistungsempfängers nach § 13b UStG', reverseCharge: true }]
    await retained(owner, owner, data, 'INCOMING')
    const { structuredIncomingInvoiceReviewExtraction } = await import('@/core/structuredIncomingInvoice')
    await prisma.documentExtraction.create({ data: { ownerId: owner, documentId: owner, status: 'CONFIRMED', provider: 'synthetic', providerVersion: '1', inputHash: 'b'.repeat(64), extractedData: JSON.stringify(structuredIncomingInvoiceReviewExtraction(data)), reviewedBy: 'tester', reviewedAt: new Date() } })
    const expense = await prisma.ledgerAccount.findFirstOrThrow({ where: { ownerId: owner, number: 4930 } })
    await expect(incoming.getIncomingInvoicePostingContext(owner, owner)).resolves.toMatchObject({ recipientAssessedVatTreatment: { configured: true } })
    const posted = await incoming.postConfirmedIncomingInvoice(owner, 'tester', owner, { expenseAccountId: expense.id, dueDate: '2026-05-15', reason: 'Reviewed synthetic reverse charge', assessmentRateBasisPoints: 1900, supplyClassification: 'SERVICE' })
    expect(posted.postingJournalEntry!.lines.map(line => [line.account.number, line.debitCents, line.creditCents])).toEqual([[4930, 11900, 0], [1787, 0, 1900], [1600, 0, 10000]])
  })

  test('Given a taxable supplier invoice posted without input deduction, when partially credited, then gross expense and payable are reduced with no input-VAT control', async () => {
    const owner = 'supplier-credit'; await tenant(owner)
    const data = invoice('SUPPLIER-ORIGINAL'); data.exemptionReason = undefined; data.lines = [{ ...data.lines[0], taxCategoryCode: 'S', taxRateBasisPoints: 1900, exemptionReason: undefined }]; data.taxAmountCents = 1900; data.grossAmountCents = 11900
    await retained(owner, owner, data, 'INCOMING')
    const { structuredIncomingInvoiceReviewExtraction } = await import('@/core/structuredIncomingInvoice')
    await prisma.documentExtraction.create({ data: { ownerId: owner, documentId: owner, status: 'CONFIRMED', provider: 'synthetic', providerVersion: '1', inputHash: 'c'.repeat(64), extractedData: JSON.stringify(structuredIncomingInvoiceReviewExtraction(data)), reviewedBy: 'tester', reviewedAt: new Date() } })
    const expense = await prisma.ledgerAccount.findFirstOrThrow({ where: { ownerId: owner, number: 4930 } })
    await incoming.postConfirmedIncomingInvoice(owner, 'tester', owner, { expenseAccountId: expense.id, dueDate: '2026-05-15', reason: 'Synthetic original purchase' })
    const credit = { ...data, kind: 'credit-note' as const, invoiceNumber: 'SUPPLIER-CREDIT', correctedInvoiceNumber: data.invoiceNumber, issueDate: '2026-05-02', supplyDate: '2026-05-02', netAmountCents: 5000, taxAmountCents: 950, grossAmountCents: 5950, lines: [{ ...data.lines[0], netAmountCents: 5000 }] }
    await retained(owner, 'supplier-credit-evidence', credit, 'INCOMING', owner)
    const { postIncomingSupplierCredit } = await import('@/server/incomingSupplierCreditNote')
    const posted = await postIncomingSupplierCredit(owner, 'tester', 'supplier-credit-evidence', { effectiveDate: '2026-05-02', requestKey: 'synthetic-supplier-credit-28', reason: 'Confirmed supplier reduction' })
    expect(posted.postingJournalEntry!.lines.map(line => [line.account.number, line.debitCents, line.creditCents])).toEqual([[1600, 5950, 0], [4930, 0, 5950]])
    await expect(prisma.vatPostingRecord.findFirst({ where: { ownerId: owner, documentId: 'supplier-credit-evidence' } })).resolves.toMatchObject({ taxCents: -950, inputTaxCents: 0, deductibleTaxCents: 0 })
  })

  test('Given a later regime change, when the original exempt invoice is credited, then its exemption persists and dated profile checks reject new contradictory sales', async () => {
    const owner = 'transition'; await tenant(owner)
    const original = invoice('BEFORE'); await retained(owner, 'before', original)
    await commercial.registerOutgoingStructuredInvoice(owner, 'tester', 'before')
    await prisma.companyProfileVersion.create({ data: { ownerId: owner, effectiveFrom: new Date('2026-07-01'), payload: JSON.stringify(profile('SKR03', 'UG', 'STANDARD')), createdBy: 'tester', reason: 'Confirmed change to standard taxation' } })
    await expect(profiles.companyVatRegimeAt(owner, '2026-06-30')).resolves.toBe('SMALL_BUSINESS')
    await expect(profiles.companyVatRegimeAt(owner, '2026-07-01')).resolves.toBe('STANDARD')
    await expect(profiles.companyVatRegimeAt(owner, '2025-12-31')).rejects.toThrow(/covering/)
    await expect(commercial.preflightOutgoingStructuredInvoiceAccounting(owner, invoice('AFTER', '2026-07-02'))).rejects.toThrow(/VAT treatment/)
    const credit = { ...invoice('CREDIT', '2026-07-02'), kind: 'credit-note' as const }
    await commercial.preflightOutgoingStructuredCorrectionAccounting(owner, 'before', credit)
    await retained(owner, 'credit', credit, 'OUTGOING', 'before')
    const posted = await commercial.registerOutgoingStructuredCorrection(owner, 'tester', 'credit', 'synthetic-credit-request')
    const lines = await prisma.journalLine.findMany({ where: { journalEntryId: posted.postingJournalEntryId! }, include: { account: true } })
    expect(lines).toHaveLength(2)
    expect(lines.find(line => line.account.number === 8192)).toMatchObject({ debitCents: 10000, taxAmountCents: 0 })
  })

  test('Given an explicit small-business tenant, when direct VAT posting requests a taxable sale or input deduction, then it is rejected without persistence', async () => {
    const owner = 'direct'; await tenant(owner)
    for (const direction of ['sale', 'purchase']) await expect(vat.persistVatPosting(owner, { sourceId: direction, amountCents: 10000, mode: 'net', taxPoint: '2026-05-01', ruleId: 'DE_STANDARD', direction })).rejects.toThrow(/effective Kleinunternehmer/)
    await expect(prisma.vatPostingRecord.count({ where: { ownerId: owner } })).resolves.toBe(0)
    await expect(profiles.companyVatRegimeAt('sale-SKR03', '2026-05-01')).resolves.toBe('SMALL_BUSINESS')
  })
})
