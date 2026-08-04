import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const directory = mkdtempSync(join(tmpdir(), 'accounting-audit-export-'))
const databasePath = join(directory, 'test.db').replace(/\\/g, '/')
const storageRoot = join(directory, 'objects')
let api: typeof import('./reportingRepository')
let prisma: typeof import('@/server/persistence/client').prisma

beforeAll(async () => {
  const database = new DatabaseSync(databasePath); const migrations = resolve(process.cwd(), 'prisma', 'migrations')
  for (const name of readdirSync(migrations, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort()) database.exec(readFileSync(join(migrations, name, 'migration.sql'), 'utf8'))
  database.close()
  process.env.DATABASE_URL = `file:${databasePath}`; process.env.DOCUMENT_STORAGE_ROOT = storageRoot; process.env.AUDIT_INTEGRITY_SECRET = 'audit-export-persistence-secret-32!'
  api = await import('./reportingRepository'); prisma = (await import('@/server/persistence/client')).prisma
  const { getDocumentStorage } = await import('@/server/storage')
  await getDocumentStorage().write('documents/tenant-a/invoice.pdf', Buffer.from('immutable invoice evidence'), { contentType: 'application/pdf', fileName: 'invoice.pdf' })
  await prisma.fiscalYear.createMany({ data: [
    { id: 'fy-2025-a', ownerId: 'tenant-a', year: 2025, startsAt: new Date('2025-01-01'), endsAt: new Date('2025-12-31T23:59:59.999Z') },
    { id: 'fy-2026-a', ownerId: 'tenant-a', year: 2026, startsAt: new Date('2026-01-01'), endsAt: new Date('2026-12-31T23:59:59.999Z') },
    { id: 'fy-2026-b', ownerId: 'tenant-b', year: 2026, startsAt: new Date('2026-01-01'), endsAt: new Date('2026-12-31T23:59:59.999Z') },
  ] })
  await prisma.companyProfileVersion.createMany({ data: [{ id: 'profile-a', ownerId: 'tenant-a', effectiveFrom: new Date('2025-01-01'), payload: JSON.stringify({ companyName: 'Audit GmbH', chart: 'CUSTOM:AUDIT' }), createdBy: 'owner-a', reason: 'initial' }, { id: 'profile-b', ownerId: 'tenant-b', effectiveFrom: new Date('2026-01-01'), payload: JSON.stringify({ companyName: 'Foreign GmbH', chart: 'CUSTOM:FOREIGN' }), createdBy: 'owner-b', reason: 'initial' }] })
  await prisma.ledgerAccount.createMany({ data: [
    { id: 'bank-a', ownerId: 'tenant-a', number: 1200, name: 'Bank', category: 'ASSET' }, { id: 'receivable-a', ownerId: 'tenant-a', number: 1400, name: 'Receivables', category: 'ASSET' }, { id: 'expense-a', ownerId: 'tenant-a', number: 4900, name: 'Expense', category: 'EXPENSE' }, { id: 'revenue-a', ownerId: 'tenant-a', number: 8400, name: 'Revenue', category: 'REVENUE' },
    { id: 'bank-b', ownerId: 'tenant-b', number: 1200, name: 'Foreign bank', category: 'ASSET' }, { id: 'revenue-b', ownerId: 'tenant-b', number: 8400, name: 'Foreign revenue', category: 'REVENUE' },
  ] })
  await prisma.accountMappingVersion.createMany({ data: [
    { id: 'map-bank-a', ownerId: 'tenant-a', chartId: 'CUSTOM:AUDIT', accountNumber: 1200, effectiveFrom: new Date('2025-01-01'), accountName: 'Bank', accountType: 'ASSET', normalBalance: 'DEBIT', hgbPosition: 'BS.A.B.IV', eBilanzPosition: 'bank' },
    { id: 'map-rec-a', ownerId: 'tenant-a', chartId: 'CUSTOM:AUDIT', accountNumber: 1400, effectiveFrom: new Date('2025-01-01'), accountName: 'Receivables', accountType: 'ASSET', normalBalance: 'DEBIT', hgbPosition: 'BS.A.B.II', eBilanzPosition: 'receivables' },
    { id: 'map-expense-a', ownerId: 'tenant-a', chartId: 'CUSTOM:AUDIT', accountNumber: 4900, effectiveFrom: new Date('2025-01-01'), accountName: 'Expense', accountType: 'EXPENSE', normalBalance: 'DEBIT', hgbPosition: 'IS.5', eBilanzPosition: 'expense' },
    { id: 'map-revenue-a', ownerId: 'tenant-a', chartId: 'CUSTOM:AUDIT', accountNumber: 8400, effectiveFrom: new Date('2025-01-01'), accountName: 'Revenue', accountType: 'REVENUE', normalBalance: 'CREDIT', hgbPosition: 'IS.1', eBilanzPosition: 'revenue' },
  ] })
  await prisma.journalEntry.create({ data: { id: 'opening-a', ownerId: 'tenant-a', fiscalYearId: 'fy-2025-a', sequenceNumber: 1, bookingDate: new Date('2025-12-31'), documentNumber: 'OPEN-1', description: 'Prior-year balance', lines: { create: [{ id: 'opening-bank', accountId: 'bank-a', debitCents: 100 }, { id: 'opening-revenue', accountId: 'revenue-a', creditCents: 100 }] } } })
  await prisma.journalEntry.create({ data: { id: 'prior-expense-a', ownerId: 'tenant-a', fiscalYearId: 'fy-2025-a', sequenceNumber: 2, bookingDate: new Date('2025-12-31'), documentNumber: 'EXP-1', description: 'Prior-year expense', lines: { create: [{ id: 'prior-expense-line', accountId: 'expense-a', debitCents: 30 }, { id: 'prior-expense-bank', accountId: 'bank-a', creditCents: 30 }] } } })
  await prisma.documentRecord.create({ data: { id: 'invoice-evidence-a', ownerId: 'tenant-a', payload: JSON.stringify({ storageKey: 'documents/tenant-a/invoice.pdf', fileName: 'invoice.pdf', contentType: 'application/pdf' }) } })
  await prisma.journalEntry.create({ data: { id: 'invoice-entry-a', ownerId: 'tenant-a', fiscalYearId: 'fy-2026-a', sequenceNumber: 1, bookingDate: new Date('2026-02-01'), documentNumber: 'INV-1', description: 'Customer invoice', lines: { create: [{ id: 'invoice-rec', accountId: 'receivable-a', debitCents: 119 }, { id: 'invoice-revenue', accountId: 'revenue-a', creditCents: 119 }] }, documents: { create: { documentId: 'invoice-evidence-a' } } } })
  await prisma.journalEntry.create({ data: { id: 'payment-entry-a', ownerId: 'tenant-a', fiscalYearId: 'fy-2026-a', sequenceNumber: 2, bookingDate: new Date('2026-02-10'), documentNumber: 'PAY-1', description: 'Partial payment', lines: { create: [{ id: 'payment-bank', accountId: 'bank-a', debitCents: 19 }, { id: 'payment-rec', accountId: 'receivable-a', creditCents: 19 }] } } })
  await prisma.journalEntry.create({ data: { id: 'credit-entry-a', ownerId: 'tenant-a', fiscalYearId: 'fy-2026-a', sequenceNumber: 3, bookingDate: new Date('2026-03-01'), documentNumber: 'CN-1', description: 'Customer credit note', lines: { create: [{ id: 'credit-revenue', accountId: 'revenue-a', debitCents: 40 }, { id: 'credit-rec', accountId: 'receivable-a', creditCents: 40 }] } } })
  await prisma.businessPartner.create({ data: { id: 'partner-a', ownerId: 'tenant-a', partnerNumber: 'K-1', role: 'CUSTOMER', name: 'Customer GmbH' } })
  await prisma.commercialDocument.create({ data: { id: 'commercial-a', ownerId: 'tenant-a', businessPartnerId: 'partner-a', evidenceDocumentId: 'invoice-evidence-a', postingJournalEntryId: 'invoice-entry-a', direction: 'RECEIVABLE', kind: 'INVOICE', status: 'POSTED', documentNumber: 'INV-1', documentIdentityKey: 'invoice-a', issueDate: new Date('2026-02-01'), serviceDate: new Date('2026-02-01'), dueDate: new Date('2026-02-15'), description: 'Customer invoice', netAmountCents: 100, taxAmountCents: 19, grossAmountCents: 119, payableAmountCents: 119, counterpartySnapshot: '{"name":"Customer GmbH"}' } })
  await prisma.openItem.create({ data: { id: 'open-a', ownerId: 'tenant-a', commercialDocumentId: 'commercial-a', side: 'DEBIT', currency: 'EUR', originalAmountCents: 119, status: 'OPEN' } })
  await prisma.commercialDocument.create({ data: { id: 'credit-commercial-a', ownerId: 'tenant-a', businessPartnerId: 'partner-a', evidenceDocumentId: 'invoice-evidence-a', postingJournalEntryId: 'credit-entry-a', correctsId: 'commercial-a', direction: 'RECEIVABLE', kind: 'CREDIT_NOTE', status: 'POSTED', documentNumber: 'CN-1', documentIdentityKey: 'credit-a', issueDate: new Date('2026-03-01'), serviceDate: new Date('2026-03-01'), dueDate: new Date('2026-03-01'), description: 'Customer credit note', netAmountCents: 40, taxAmountCents: 0, grossAmountCents: 40, payableAmountCents: 40, counterpartySnapshot: '{"name":"Customer GmbH"}' } })
  await prisma.openItem.create({ data: { id: 'credit-open-a', ownerId: 'tenant-a', commercialDocumentId: 'credit-commercial-a', side: 'CREDIT', currency: 'EUR', originalAmountCents: 40, status: 'OPEN' } })
  await prisma.paymentSettlement.create({ data: { id: 'settlement-a', ownerId: 'tenant-a', businessPartnerId: 'partner-a', journalEntryId: 'payment-entry-a', direction: 'RECEIPT', currency: 'EUR', amountCents: 29, status: 'UNALLOCATED', occurredOn: new Date('2026-02-10'), createdBy: 'owner-a' } })
  await prisma.settlementAllocation.create({ data: { id: 'allocation-a', ownerId: 'tenant-a', openItemId: 'open-a', settlementId: 'settlement-a', journalEntryId: 'payment-entry-a', kind: 'APPLY', amountCents: 19, requestKey: 'allocation-request-a', requestHash: 'a'.repeat(64), effectiveDate: new Date('2026-02-10'), createdBy: 'owner-a' } })
  await prisma.correctionNetting.create({ data: { id: 'netting-a', ownerId: 'tenant-a', correctionDocumentId: 'credit-commercial-a', originalOpenItemId: 'open-a', creditOpenItemId: 'credit-open-a', journalEntryId: 'credit-entry-a', amountCents: 40, requestKey: 'netting-request-a', requestHash: 'b'.repeat(64), effectiveDate: new Date('2026-03-01'), createdBy: 'owner-a' } })
  await prisma.settlementAllocation.create({ data: { id: 'future-allocation-a', ownerId: 'tenant-a', openItemId: 'open-a', settlementId: 'settlement-a', journalEntryId: 'payment-entry-a', kind: 'APPLY', amountCents: 10, requestKey: 'future-allocation-request-a', requestHash: 'c'.repeat(64), effectiveDate: new Date('2027-01-01'), createdBy: 'owner-a' } })
  await prisma.fixedAssetRecord.createMany({ data: [
    { id: 'asset-current', ownerId: 'tenant-a', payload: JSON.stringify({ acquisitionDate: '2026-04-01', description: 'Current machine' }), createdBy: 'owner-a' },
    { id: 'asset-future', ownerId: 'tenant-a', payload: JSON.stringify({ acquisitionDate: '2027-01-01', description: 'Future machine' }), createdBy: 'owner-a' },
  ] })
  await prisma.assetEventRecord.createMany({ data: [
    { id: 'event-current', ownerId: 'tenant-a', assetId: 'asset-current', sequence: 1, payload: JSON.stringify({ effectiveDate: '2026-06-01', type: 'TRANSFER' }), postingId: 'asset-post-current', approvedBy: 'owner-a', approvedAt: new Date('2026-06-01') },
    { id: 'event-future', ownerId: 'tenant-a', assetId: 'asset-current', sequence: 2, payload: JSON.stringify({ effectiveDate: '2027-01-01', type: 'TRANSFER' }), postingId: 'asset-post-future', approvedBy: 'owner-a', approvedAt: new Date('2027-01-01') },
  ] })
})

afterAll(async () => { await prisma.$disconnect(); delete process.env.DATABASE_URL; delete process.env.DOCUMENT_STORAGE_ROOT; delete process.env.AUDIT_INTEGRITY_SECRET; rmSync(directory, { recursive: true, force: true }) })

describe('persistent authoritative GoBD export', () => {
  it('Given prior and future activity, when an audit package is created, then balance-sheet openings carry, P&L openings reset, period-cutoff OPOS and settlements exclude future activity, and evidence plus tenant data stay exact', async () => {
    const record = await api.createDomainReportingPackage('tenant-a', 'owner-a', 'AUDIT_EXPORT', { fiscalPeriodId: 'fy-2026-a', authorityReference: 'AO §147(6)', reason: 'Tax audit export' })
    const auditPackage = JSON.parse(record.payload) as { files: Record<string, string>; manifest: { packageChecksum: string } }
    expect(JSON.parse(auditPackage.files['data/openingClosing.json'])).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: 'map-bank-a', openingCents: 70, closingCents: 89 }),
      expect.objectContaining({ accountId: 'map-revenue-a', openingCents: 0, closingCents: -79 }),
      expect.objectContaining({ accountId: 'map-expense-a', openingCents: 0, closingCents: 0 }),
    ]))
    expect(JSON.parse(auditPackage.files['data/evidence.json'])).toEqual([expect.objectContaining({ id: 'invoice-evidence-a', fileName: 'invoice.pdf', sizeBytes: 26, bytes: { $type: 'Uint8Array', $base64: expect.any(String) } })])
    expect(JSON.parse(auditPackage.files['data/businessPartners.json'])).toEqual([expect.objectContaining({ id: 'partner-a', name: 'Customer GmbH' })])
    expect(JSON.parse(auditPackage.files['data/commercialDocuments.json'])).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'commercial-a', documentNumber: 'INV-1' }), expect.objectContaining({ id: 'credit-commercial-a', correctsId: 'commercial-a' })]))
    expect(JSON.parse(auditPackage.files['data/openItems.json'])).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'open-a', allocatedAmountCents: 59, outstandingCents: 60 }), expect.objectContaining({ id: 'credit-open-a', allocatedAmountCents: 40, outstandingCents: 0 })]))
    expect(JSON.parse(auditPackage.files['data/settlementAllocations.json'])).toEqual([expect.objectContaining({ id: 'allocation-a', amountCents: 19 })])
    expect(JSON.parse(auditPackage.files['data/paymentSettlements.json'])).toEqual([expect.objectContaining({ id: 'settlement-a', allocatedAmountCents: 19, status: 'PARTIAL' })])
    expect(JSON.parse(auditPackage.files['data/correctionNettings.json'])).toEqual([expect.objectContaining({ id: 'netting-a', originalOpenItemId: 'open-a', creditOpenItemId: 'credit-open-a', amountCents: 40 })])
    expect(JSON.parse(auditPackage.files['data/fixedAssets.json'])).toEqual([expect.objectContaining({ id: 'asset-current', acquisitionDate: '2026-04-01' })])
    expect(JSON.parse(auditPackage.files['data/assetEvents.json'])).toEqual([expect.objectContaining({ id: 'event-current', effectiveDate: '2026-06-01' })])
    expect(record.checksum).toMatch(/^[a-f0-9]{64}$/); expect(auditPackage.manifest.packageChecksum).toMatch(/^[a-f0-9]{64}$/)
    expect(record.payload).not.toContain('tenant-b'); expect(await prisma.compliancePackage.count({ where: { ownerId: 'tenant-a', kind: 'AUDIT_EXPORT' } })).toBe(1)
    const download = await api.downloadReportingPackage('tenant-a', 'auditor-a', record.id)
    expect(download.content.equals(Buffer.from(record.payload))).toBe(true); expect(download.fileName).toBe('gobd-audit-2026-v1.json'); expect(download.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(await prisma.auditEvent.findFirst({ where: { ownerId: 'tenant-a', actorId: 'auditor-a', action: 'EXPORT_DOWNLOADED', objectId: record.id } })).toBeTruthy()
    await expect(api.downloadReportingPackage('tenant-b', 'auditor-b', record.id)).rejects.toThrow(/not found/)
  })

  it('Given malformed authoritative asset dates, when an audit package is requested, then the export fails closed', async () => {
    await prisma.fixedAssetRecord.create({ data: { id: 'asset-malformed', ownerId: 'tenant-a', payload: JSON.stringify({ acquisitionDate: '2026-02-30' }), createdBy: 'owner-a' } })
    await expect(api.createDomainReportingPackage('tenant-a', 'owner-a', 'AUDIT_EXPORT', { fiscalPeriodId: 'fy-2026-a', authorityReference: 'AO §147(6)', reason: 'Malformed asset check' })).rejects.toThrow('must be a real ISO date')
    await prisma.fixedAssetRecord.delete({ where: { id: 'asset-malformed' } })
  })
})
