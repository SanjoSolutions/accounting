import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PrismaClient } from '@/generated/prisma/client'

vi.mock('server-only', () => ({}))
const directory = mkdtempSync(join(tmpdir(), 'accounting-fixed-assets-')); const databasePath = join(directory, 'test.db').replace(/\\/g, '/')
let api: typeof import('./fixedAssetsRepository'); let prisma: typeof import('@/server/persistence/client').prisma

beforeAll(async () => {
  const database = new DatabaseSync(databasePath); const migrations = resolve(process.cwd(), 'prisma', 'migrations')
  for (const name of readdirSync(migrations, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort()) database.exec(readFileSync(join(migrations, name, 'migration.sql'), 'utf8'))
  database.close(); process.env.DATABASE_URL = `file:${databasePath}`; process.env.AUDIT_INTEGRITY_SECRET = 'fixed-assets-test-audit-secret-32!!'
  api = await import('./fixedAssetsRepository'); prisma = (await import('@/server/persistence/client')).prisma
  await prisma.fiscalYear.createMany({ data: [{ id: 'fy-a', ownerId: 'tenant-a', year: 2026, startsAt: new Date('2026-01-01'), endsAt: new Date('2026-12-31T23:59:59.999Z') }, { id: 'fy-b', ownerId: 'tenant-b', year: 2026, startsAt: new Date('2026-01-01'), endsAt: new Date('2026-12-31T23:59:59.999Z') }] })
  await prisma.ledgerProfile.createMany({ data: [{ ownerId: 'tenant-a', chart: 'SKR03', accountLength: 4 }, { ownerId: 'tenant-b', chart: 'SKR03', accountLength: 4 }] })
  await prisma.businessPartner.createMany({ data: [{ id: 'customer-a', ownerId: 'tenant-a', partnerNumber: 'K-100', role: 'CUSTOMER', name: 'Berlin Buyer GmbH', countryCode: 'DE', paymentTermDays: 14 }, { id: 'customer-b', ownerId: 'tenant-b', partnerNumber: 'K-200', role: 'CUSTOMER', name: 'Foreign tenant buyer', countryCode: 'DE', paymentTermDays: 14 }] })
  await prisma.ledgerAccount.createMany({ data: [{ id: 'asset-a', ownerId: 'tenant-a', number: 300, name: 'BGA', category: 'ASSET' }, { id: 'expense-a', ownerId: 'tenant-a', number: 4830, name: 'Depreciation', category: 'EXPENSE' }, { id: 'disposal-expense-a', ownerId: 'tenant-a', number: 2310, name: 'Asset retirement loss', category: 'EXPENSE' }, { id: 'gain-carrying-a', ownerId: 'tenant-a', number: 2315, name: 'Asset carrying value on book gain', category: 'REVENUE' }, { id: 'receivable-a', ownerId: 'tenant-a', number: 1400, name: 'Trade receivables', category: 'ASSET' }, { id: 'output-vat-a', ownerId: 'tenant-a', number: 1776, name: 'Output VAT 19%', category: 'LIABILITY' }, { id: 'loss-proceeds-a', ownerId: 'tenant-a', number: 8801, name: 'Asset sale proceeds on book loss', category: 'EXPENSE' }, { id: 'gain-proceeds-a', ownerId: 'tenant-a', number: 8820, name: 'Asset sale proceeds on book gain', category: 'REVENUE' }, { id: 'payable-a', ownerId: 'tenant-a', number: 1600, name: 'Payables', category: 'LIABILITY' }, { id: 'asset-b', ownerId: 'tenant-b', number: 300, name: 'BGA', category: 'ASSET' }, { id: 'disposal-expense-b', ownerId: 'tenant-b', number: 2310, name: 'Asset retirement loss', category: 'EXPENSE' }, { id: 'payable-b', ownerId: 'tenant-b', number: 1600, name: 'Payables', category: 'LIABILITY' }] })
  await prisma.documentRecord.createMany({ data: [{ id: 'evidence-a', ownerId: 'tenant-a', payload: '{"fileName":"laptop.pdf"}' }, { id: 'evidence-other-a', ownerId: 'tenant-a', payload: '{"fileName":"other.pdf"}' }, { id: 'sale-evidence-a', ownerId: 'tenant-a', payload: '{"fileName":"sale-contract.pdf"}' }, { id: 'evidence-b', ownerId: 'tenant-b', payload: '{}' }] })
  await prisma.journalEntry.create({ data: { id: 'acquisition-a', ownerId: 'tenant-a', fiscalYearId: 'fy-a', sequenceNumber: 1, bookingDate: new Date('2026-01-10'), documentNumber: 'ACQ-1', description: 'Capitalized laptop', state: 'POSTED', lines: { create: [{ id: 'acquisition-line-a', accountId: 'asset-a', debitCents: 100 }, { id: 'acquisition-credit-a', accountId: 'payable-a', creditCents: 100 }] }, documents: { create: { documentId: 'evidence-a' } } } })
  await prisma.journalEntry.create({ data: { id: 'acquisition-b', ownerId: 'tenant-b', fiscalYearId: 'fy-b', sequenceNumber: 1, bookingDate: new Date('2026-01-10'), documentNumber: 'ACQ-B', description: 'Foreign capitalized asset', state: 'POSTED', lines: { create: [{ id: 'acquisition-line-b', accountId: 'asset-b', debitCents: 100 }, { id: 'acquisition-credit-b', accountId: 'payable-b', creditCents: 100 }] }, documents: { create: { documentId: 'evidence-b' } } } })
  await prisma.journalEntry.create({ data: { id: 'acquisition-sale-gain', ownerId: 'tenant-a', fiscalYearId: 'fy-a', sequenceNumber: 2, bookingDate: new Date('2026-01-10'), documentNumber: 'ACQ-SALE-GAIN', description: 'Capitalized sale asset', state: 'POSTED', lines: { create: [{ id: 'acquisition-sale-gain-line', accountId: 'asset-a', debitCents: 120 }, { accountId: 'payable-a', creditCents: 120 }] }, documents: { create: { documentId: 'evidence-a' } } } })
  await prisma.journalEntry.create({ data: { id: 'acquisition-sale-loss', ownerId: 'tenant-a', fiscalYearId: 'fy-a', sequenceNumber: 3, bookingDate: new Date('2026-01-10'), documentNumber: 'ACQ-SALE-LOSS', description: 'Capitalized loss asset', state: 'POSTED', lines: { create: [{ id: 'acquisition-sale-loss-line', accountId: 'asset-a', debitCents: 120 }, { accountId: 'payable-a', creditCents: 120 }] }, documents: { create: { documentId: 'evidence-a' } } } })
})

afterAll(async () => { await prisma.$disconnect(); delete process.env.DATABASE_URL; delete process.env.AUDIT_INTEGRITY_SECRET; rmSync(directory, { recursive: true, force: true }) })

describe('persistent fixed-asset register', () => {
  let assetId = ''; let depreciationEventId = ''
  it('Given tenant evidence and accounts, when an acquisition is registered, then an exact-cent schedule persists with source provenance', async () => {
    const input = { requestKey: 'asset-request-tenant-a-0001', description: 'Development laptop', costCents: 100, acquisitionDate: '2026-01-10', availableForUseDate: '2026-01-10', location: 'Berlin', usefulLifeMonths: 3, assetAccountId: 'asset-a', depreciationExpenseAccountId: 'expense-a', sourceDocumentId: 'evidence-a', acquisitionJournalLineId: 'acquisition-line-a' }
    await expect(api.getFixedAssetWorkspace('tenant-a')).resolves.toEqual(expect.objectContaining({ acquisitionCandidates: expect.arrayContaining([expect.objectContaining({ id: 'acquisition-line-a', journalEntryId: 'acquisition-a', debitCents: 100, documentIds: ['evidence-a'] })]) }))
    const [created, replay] = await Promise.all([api.createFixedAsset('tenant-a', 'user-a', input), api.createFixedAsset('tenant-a', 'user-a', input)])
    assetId = created.id
    expect(replay.id).toBe(created.id)
    expect(created.schedule.map(row => row.amountCents)).toEqual([33, 34, 33])
    await expect(api.createFixedAsset('tenant-a', 'user-a', { ...input, requestKey: 'asset-request-tenant-a-0002', description: 'Foreign evidence', sourceDocumentId: 'evidence-b' })).rejects.toThrow(/does not belong/)
    await expect(prisma.fixedAssetRecord.count({ where: { ownerId: 'tenant-a' } })).resolves.toBe(1)
    await expect(api.createFixedAsset('tenant-a', 'user-a', { ...input, description: 'Different laptop' })).rejects.toThrow(/different acquisition facts/)
    await expect(api.createFixedAsset('tenant-a', 'user-a', { ...input, requestKey: 'asset-request-tenant-a-0003' })).rejects.toThrow(/already assigned/)
    await expect(api.getFixedAssetWorkspace('tenant-a')).resolves.toEqual(expect.objectContaining({ acquisitionCandidates: expect.not.arrayContaining([expect.objectContaining({ id: 'acquisition-line-a' })]) }))
    await expect(prisma.$executeRawUnsafe(`INSERT INTO FixedAssetRecord (id, ownerId, payload, acquisitionJournalLineId, createdBy, createdAt) VALUES ('raw-duplicate', 'tenant-a', '{}', 'acquisition-line-a', 'user-a', CURRENT_TIMESTAMP)`)).rejects.toThrow(/UNIQUE constraint/)
  })

  it('Given unverified acquisition claims, when registration is attempted, then amount, account, evidence, date, state and tenant mismatches fail closed', async () => {
    const base = { requestKey: 'asset-rejection-request-0001', description: 'Rejected laptop', costCents: 100, acquisitionDate: '2026-01-10', availableForUseDate: '2026-01-10', location: 'Berlin', usefulLifeMonths: 3, assetAccountId: 'asset-a', depreciationExpenseAccountId: 'expense-a', sourceDocumentId: 'evidence-a', acquisitionJournalLineId: 'acquisition-line-a' }
    await expect(api.createFixedAsset('tenant-a', 'user-a', { ...base, requestKey: 'asset-rejection-amount-01', costCents: 99 })).rejects.toThrow(/exact acquisition cost/)
    await expect(api.createFixedAsset('tenant-a', 'user-a', { ...base, requestKey: 'asset-rejection-account-1', assetAccountId: 'asset-b' })).rejects.toThrow(/tenant asset/)
    await expect(api.createFixedAsset('tenant-a', 'user-a', { ...base, requestKey: 'asset-rejection-evidence1', sourceDocumentId: 'evidence-other-a' })).rejects.toThrow(/linked to the selected acquisition evidence/)
    await expect(api.createFixedAsset('tenant-a', 'user-a', { ...base, requestKey: 'asset-rejection-date-0001', acquisitionDate: '2026-01-11', availableForUseDate: '2026-01-11' })).rejects.toThrow(/booking date/)
    await expect(api.createFixedAsset('tenant-a', 'user-a', { ...base, requestKey: 'asset-rejection-tenant-01', acquisitionJournalLineId: 'acquisition-line-b' })).rejects.toThrow(/posted tenant journal/)
    await prisma.journalEntry.create({ data: { id: 'draft-acquisition', ownerId: 'tenant-a', fiscalYearId: 'fy-a', sequenceNumber: 4, bookingDate: new Date('2026-01-10'), documentNumber: 'DRAFT-1', description: 'Unposted acquisition', state: 'DRAFT', lines: { create: [{ id: 'draft-acquisition-line', accountId: 'asset-a', debitCents: 100 }, { accountId: 'payable-a', creditCents: 100 }] }, documents: { create: { documentId: 'evidence-a' } } } })
    await expect(api.createFixedAsset('tenant-a', 'user-a', { ...base, requestKey: 'asset-rejection-draft-001', acquisitionJournalLineId: 'draft-acquisition-line' })).rejects.toThrow(/posted tenant journal/)
    await prisma.journalEntry.create({ data: { id: 'expense-only', ownerId: 'tenant-a', fiscalYearId: 'fy-a', sequenceNumber: 5, bookingDate: new Date('2026-01-10'), documentNumber: 'EXP-1', description: 'Expense-only payable posting', state: 'POSTED', lines: { create: [{ id: 'expense-only-line', accountId: 'expense-a', debitCents: 100 }, { accountId: 'payable-a', creditCents: 100 }] }, documents: { create: { documentId: 'evidence-a' } } } })
    await expect(api.createFixedAsset('tenant-a', 'user-a', { ...base, requestKey: 'asset-rejection-expense01', acquisitionJournalLineId: 'expense-only-line' })).rejects.toThrow(/selected asset account/)
    await expect(prisma.fixedAssetRecord.count({ where: { ownerId: 'tenant-a' } })).resolves.toBe(1)
  })

  it('Given a scheduled period, when posting is confirmed and retried, then one balanced evidenced journal and immutable event persist', async () => {
    const first = await api.postFixedAssetDepreciation('tenant-a', 'user-a', assetId, '2026-01', 'January depreciation approved')
    const replay = await api.postFixedAssetDepreciation('tenant-a', 'user-a', assetId, '2026-01', 'Safe retry')
    depreciationEventId = first.event.id
    expect(replay.event.id).toBe(first.event.id)
    expect(first.event).toMatchObject({ type: 'DEPRECIATION', effectiveDate: '2026-01-31', amountCents: 33 })
    expect(first.journal.lines.map(line => ({ number: line.account.number, debit: line.debitCents, credit: line.creditCents }))).toEqual([{ number: 4830, debit: 33, credit: 0 }, { number: 300, debit: 0, credit: 33 }])
    expect(first.journal.documents).toEqual([{ journalEntryId: first.journal.id, documentId: 'evidence-a' }])
    await expect(prisma.assetEventRecord.count({ where: { ownerId: 'tenant-a', assetId } })).resolves.toBe(1)
    await expect(prisma.journalEntry.count({ where: { ownerId: 'tenant-a', source: 'FIXED_ASSET' } })).resolves.toBe(1)
    await expect(api.postFixedAssetDepreciation('tenant-b', 'user-b', assetId, '2026-01', 'Wrong tenant')).rejects.toThrow(/does not belong/)
  })

  it('Given posted depreciation, when corrected and retried, then append-only reversal evidence and the reversing journal persist', async () => {
    const before = await prisma.assetEventRecord.findUniqueOrThrow({ where: { id: depreciationEventId } })
    const first = await api.reverseFixedAssetDepreciation('tenant-a', 'user-a', assetId, depreciationEventId, '2026-02-28', 'January posting corrected')
    const replay = await api.reverseFixedAssetDepreciation('tenant-a', 'user-a', assetId, depreciationEventId, '2026-02-28', 'Safe retry')
    expect(replay.event.id).toBe(first.event.id); expect(first.event).toMatchObject({ type: 'REVERSAL', reversesEventId: depreciationEventId, amountCents: 33 })
    await expect(prisma.assetEventRecord.findUnique({ where: { id: depreciationEventId } })).resolves.toEqual(before)
    expect(first.journal.lines.map(line => ({ debit: line.debitCents, credit: line.creditCents }))).toEqual([{ debit: 0, credit: 33 }, { debit: 33, credit: 0 }])
    await expect(prisma.assetEventRecord.count({ where: { ownerId: 'tenant-a', assetId } })).resolves.toBe(2)
    await expect(prisma.auditEvent.count({ where: { ownerId: 'tenant-a', objectType: { in: ['FixedAssetRecord', 'AssetEventRecord'] } } })).resolves.toBe(3)
    const reopened = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${databasePath}` }) })
    await expect(reopened.assetEventRecord.findMany({ where: { ownerId: 'tenant-a', assetId }, orderBy: { sequence: 'asc' } })).resolves.toHaveLength(2)
    await expect(reopened.journalEntry.findMany({ where: { ownerId: 'tenant-a', source: { in: ['FIXED_ASSET', 'FIXED_ASSET_REVERSAL'] } } })).resolves.toHaveLength(2)
    await reopened.$disconnect()
  })

  it('Given a partially depreciated evidenced asset, when it is fully retired without proceeds, then its exact carrying value is derecognized once and no later depreciation is possible', async () => {
    const input = { requestKey: 'asset-retirement-request-0001', effectiveDate: '2026-03-15', evidenceDocumentId: 'evidence-other-a', disposalExpenseAccountId: 'disposal-expense-a', reason: 'Device irreparably destroyed and approved for retirement' }
    const [first, replay] = await Promise.all([api.disposeFixedAsset('tenant-a', 'user-a', assetId, input), api.disposeFixedAsset('tenant-a', 'user-a', assetId, input)])
    expect(replay.event.id).toBe(first.event.id)
    expect(first.event).toMatchObject({ type: 'DISPOSAL', effectiveDate: '2026-03-15', amountCents: 0, carryingAmountCents: 100, evidenceIds: ['evidence-other-a'] })
    expect(first.journal.lines.map(line => ({ number: line.account.number, debit: line.debitCents, credit: line.creditCents }))).toEqual([{ number: 2310, debit: 100, credit: 0 }, { number: 300, debit: 0, credit: 100 }])
    expect(first.journal.documents).toEqual([{ journalEntryId: first.journal.id, documentId: 'evidence-other-a' }])
    await expect(api.getFixedAssetWorkspace('tenant-a')).resolves.toMatchObject({ assets: [{ id: assetId, lifecycle: { disposed: true, disposedOn: '2026-03-15', carryingAmountCents: 0 } }] })
    await expect(api.postFixedAssetDepreciation('tenant-a', 'user-a', assetId, '2026-02', 'Must fail after retirement')).rejects.toThrow(/after full retirement/)
    await expect(api.disposeFixedAsset('tenant-a', 'user-a', assetId, { ...input, requestKey: 'asset-retirement-request-0002' })).rejects.toThrow(/already retired/)
    await expect(api.disposeFixedAsset('tenant-b', 'user-b', assetId, { ...input, requestKey: 'asset-retirement-request-0003', disposalExpenseAccountId: 'disposal-expense-b' })).rejects.toThrow(/does not belong/)
    await expect(prisma.$executeRawUnsafe(`UPDATE AssetEventRecord SET payload = '{}' WHERE id = '${first.event.id}'`)).rejects.toThrow(/asset event history is immutable/)
    await expect(prisma.auditEvent.findFirst({ where: { ownerId: 'tenant-a', action: 'FIXED_ASSET_DISPOSED', objectId: first.event.id } })).resolves.toMatchObject({ actorId: 'user-a' })
  })

  it('Given partially depreciated assets, when domestic full sales produce a gain and a loss, then DATEV result pairs, output VAT, evidence, lifecycle locks, actor, and idempotency persist atomically', async () => {
    const registration = (requestKey: string, description: string, acquisitionJournalLineId: string) => ({ requestKey, description, costCents: 120, acquisitionDate: '2026-01-10', availableForUseDate: '2026-01-10', location: 'Berlin', usefulLifeMonths: 3, assetAccountId: 'asset-a', depreciationExpenseAccountId: 'expense-a', sourceDocumentId: 'evidence-a', acquisitionJournalLineId })
    const gainAsset = await api.createFixedAsset('tenant-a', 'accountant-sale', registration('asset-sale-gain-registration-1', 'Sale gain laptop', 'acquisition-sale-gain-line'))
    const lossAsset = await api.createFixedAsset('tenant-a', 'accountant-sale', registration('asset-sale-loss-registration-1', 'Sale loss laptop', 'acquisition-sale-loss-line'))
    const gainDepreciation = await api.postFixedAssetDepreciation('tenant-a', 'accountant-sale', gainAsset.id, '2026-01', 'Approved before sale')
    await api.postFixedAssetDepreciation('tenant-a', 'accountant-sale', lossAsset.id, '2026-01', 'Approved before sale')
    const sale = (requestKey: string, netProceedsCents: number, result: 'GAIN' | 'LOSS') => ({ requestKey, effectiveDate: '2026-02-15', evidenceDocumentId: 'sale-evidence-a', netProceedsCents, vatRateBasisPoints: 1900, businessPartnerId: 'customer-a', invoiceNumber: `SALE-${requestKey}`, receivableAccountId: 'receivable-a', proceedsAccountId: result === 'GAIN' ? 'gain-proceeds-a' : 'loss-proceeds-a', carryingValueAccountId: result === 'GAIN' ? 'gain-carrying-a' : 'disposal-expense-a', outputVatAccountId: 'output-vat-a', reason: `Management approved ${result.toLowerCase()} sale` })
    const gainInput = sale('asset-sale-gain-request-0001', 100, 'GAIN')
    const [gain, gainReplay] = await Promise.all([api.sellFixedAsset('tenant-a', 'accountant-sale', gainAsset.id, gainInput), api.sellFixedAsset('tenant-a', 'accountant-sale', gainAsset.id, gainInput)])
    expect(gainReplay.event.id).toBe(gain.event.id)
    expect(gain.event).toMatchObject({ disposalKind: 'SALE', carryingAmountCents: 80, netProceedsCents: 100, outputVatCents: 19, grossProceedsCents: 119, gainLossCents: 20, result: 'GAIN', evidenceIds: ['sale-evidence-a'] })
    expect(gain.journal.lines.map(line => ({ number: line.account.number, debit: line.debitCents, credit: line.creditCents })).sort((a, b) => a.number - b.number)).toEqual([{ number: 300, debit: 0, credit: 80 }, { number: 1400, debit: 119, credit: 0 }, { number: 1776, debit: 0, credit: 19 }, { number: 2315, debit: 80, credit: 0 }, { number: 8820, debit: 0, credit: 100 }])
    expect(gain.commercialDocument).toMatchObject({ businessPartnerId: 'customer-a', evidenceDocumentId: 'sale-evidence-a', postingJournalEntryId: gain.journal.id, direction: 'RECEIVABLE', kind: 'INVOICE', status: 'POSTED', documentNumber: 'SALE-asset-sale-gain-request-0001', netAmountCents: 100, taxAmountCents: 19, grossAmountCents: 119, payableAmountCents: 119, openItem: { side: 'DEBIT', currency: 'EUR', originalAmountCents: 119, allocatedAmountCents: 0, status: 'OPEN' }, businessPartner: { name: 'Berlin Buyer GmbH' } })
    await expect(prisma.openItem.count({ where: { ownerId: 'tenant-a', commercialDocument: { postingJournalEntryId: gain.journal.id } } })).resolves.toBe(1)
    await expect(prisma.vatPostingRecord.findFirst({ where: { ownerId: 'tenant-a', documentId: 'sale-evidence-a', journalLineId: { not: null } } })).resolves.toMatchObject({ sourceId: `fixed-asset-sale:${gain.event.id}:vat`, ruleId: 'DE_STANDARD', netBaseCents: 100, outputTaxCents: 19, returnBoxes: JSON.stringify([{ box: '81', value: 'net-base', direction: 'sale' }]) })
    await expect(api.sellFixedAsset('tenant-a', 'accountant-sale', gainAsset.id, { ...gainInput, netProceedsCents: 101 })).rejects.toThrow(/request key.*different facts/)
    const beforeDuplicateInvoice = { events: await prisma.assetEventRecord.count({ where: { ownerId: 'tenant-a', assetId: lossAsset.id } }), journals: await prisma.journalEntry.count({ where: { ownerId: 'tenant-a', source: 'FIXED_ASSET_SALE' } }), documents: await prisma.commercialDocument.count({ where: { ownerId: 'tenant-a', postingJournalEntry: { source: 'FIXED_ASSET_SALE' } } }), openItems: await prisma.openItem.count({ where: { ownerId: 'tenant-a', commercialDocument: { postingJournalEntry: { source: 'FIXED_ASSET_SALE' } } } }), vat: await prisma.vatPostingRecord.count({ where: { ownerId: 'tenant-a', sourceId: { startsWith: 'fixed-asset-sale:' } } }) }
    await expect(api.sellFixedAsset('tenant-a', 'accountant-sale', lossAsset.id, { ...sale('asset-sale-duplicate-invoice-1', 50, 'LOSS'), invoiceNumber: gainInput.invoiceNumber })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/invoice number.*already used/) })
    await expect(Promise.all([prisma.assetEventRecord.count({ where: { ownerId: 'tenant-a', assetId: lossAsset.id } }), prisma.journalEntry.count({ where: { ownerId: 'tenant-a', source: 'FIXED_ASSET_SALE' } }), prisma.commercialDocument.count({ where: { ownerId: 'tenant-a', postingJournalEntry: { source: 'FIXED_ASSET_SALE' } } }), prisma.openItem.count({ where: { ownerId: 'tenant-a', commercialDocument: { postingJournalEntry: { source: 'FIXED_ASSET_SALE' } } } }), prisma.vatPostingRecord.count({ where: { ownerId: 'tenant-a', sourceId: { startsWith: 'fixed-asset-sale:' } } })])).resolves.toEqual([beforeDuplicateInvoice.events, beforeDuplicateInvoice.journals, beforeDuplicateInvoice.documents, beforeDuplicateInvoice.openItems, beforeDuplicateInvoice.vat])
    const beforeRejectedCustomer = { events: await prisma.assetEventRecord.count({ where: { ownerId: 'tenant-a', assetId: lossAsset.id } }), journals: await prisma.journalEntry.count({ where: { ownerId: 'tenant-a', source: 'FIXED_ASSET_SALE' } }), documents: await prisma.commercialDocument.count({ where: { ownerId: 'tenant-a', postingJournalEntry: { source: 'FIXED_ASSET_SALE' } } }), vat: await prisma.vatPostingRecord.count({ where: { ownerId: 'tenant-a', sourceId: { startsWith: 'fixed-asset-sale:' } } }) }
    await expect(api.sellFixedAsset('tenant-a', 'accountant-sale', lossAsset.id, { ...sale('asset-sale-foreign-customer-1', 50, 'LOSS'), businessPartnerId: 'customer-b' })).rejects.toThrow(/active domestic tenant customer/)
    await expect(Promise.all([prisma.assetEventRecord.count({ where: { ownerId: 'tenant-a', assetId: lossAsset.id } }), prisma.journalEntry.count({ where: { ownerId: 'tenant-a', source: 'FIXED_ASSET_SALE' } }), prisma.commercialDocument.count({ where: { ownerId: 'tenant-a', postingJournalEntry: { source: 'FIXED_ASSET_SALE' } } }), prisma.vatPostingRecord.count({ where: { ownerId: 'tenant-a', sourceId: { startsWith: 'fixed-asset-sale:' } } })])).resolves.toEqual([beforeRejectedCustomer.events, beforeRejectedCustomer.journals, beforeRejectedCustomer.documents, beforeRejectedCustomer.vat])
    await expect(api.sellFixedAsset('tenant-a', 'accountant-sale', lossAsset.id, { ...sale('asset-sale-wrong-pair-0001', 50, 'LOSS'), proceedsAccountId: 'gain-proceeds-a' })).rejects.toThrow(/book-loss.*accounts/)
    const loss = await api.sellFixedAsset('tenant-a', 'accountant-sale', lossAsset.id, sale('asset-sale-loss-request-0001', 50, 'LOSS'))
    expect(loss.event).toMatchObject({ carryingAmountCents: 80, netProceedsCents: 50, outputVatCents: 10, grossProceedsCents: 60, gainLossCents: -30, result: 'LOSS' })
    expect(loss.journal.lines.map(line => line.account.number).sort((a, b) => a - b)).toEqual([300, 1400, 1776, 2310, 8801])
    const workspace = await api.getFixedAssetWorkspace('tenant-a'); expect(workspace.assets.find(asset => asset.id === gainAsset.id)?.lifecycle).toEqual({ disposed: true, disposedOn: '2026-02-15', disposalKind: 'SALE', carryingAmountCents: 0, netProceedsCents: 100, outputVatCents: 19, gainLossCents: 20, result: 'GAIN' })
    await expect(api.postFixedAssetDepreciation('tenant-a', 'accountant-sale', gainAsset.id, '2026-02', 'Must remain closed')).rejects.toThrow(/after full retirement/)
    await expect(api.reverseFixedAssetDepreciation('tenant-a', 'accountant-sale', gainAsset.id, gainDepreciation.event.id, '2026-02-28', 'Must remain immutable')).rejects.toThrow(/after full retirement/)
    await expect(api.sellFixedAsset('tenant-a', 'accountant-sale', gainAsset.id, { ...gainInput, requestKey: 'asset-sale-conflict-request-1' })).rejects.toThrow(/already disposed/)
    await expect(api.sellFixedAsset('tenant-b', 'foreign-actor', gainAsset.id, { ...gainInput, requestKey: 'asset-sale-foreign-request-1' })).rejects.toThrow(/does not belong/)
    await expect(prisma.auditEvent.findFirst({ where: { ownerId: 'tenant-a', action: 'FIXED_ASSET_SOLD', objectId: gain.event.id } })).resolves.toMatchObject({ actorId: 'accountant-sale' })
    await expect(prisma.$executeRawUnsafe(`DELETE FROM VatPostingRecord WHERE sourceId = 'fixed-asset-sale:${gain.event.id}:vat'`)).rejects.toThrow(/VAT posting facts are append-only/)
  })
})
