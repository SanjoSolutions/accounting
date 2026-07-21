import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

const mocks = vi.hoisted(() => {
  const compliancePackage = { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() }
  const transaction = {
    compliancePackage, procedureDocumentRecord: { create: vi.fn(), findMany: vi.fn() }, retainedArtifact: { create: vi.fn() },
    fixedAssetRecord: { findMany: vi.fn() }, assetEventRecord: { findMany: vi.fn() }, inventoryItemRecord: { findMany: vi.fn() }, inventoryCountSnapshot: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
    cashBookRecord: { findMany: vi.fn(), findFirst: vi.fn() }, cashEntryRecord: { findMany: vi.fn() }, cashCloseRecord: { findMany: vi.fn() },
    fiscalYear: { findFirst: vi.fn() }, companyProfileVersion: { findFirst: vi.fn(), findMany: vi.fn() }, accountMappingVersion: { findMany: vi.fn() }, auditEvent: { findMany: vi.fn() }, taxWorkflowRecord: { findMany: vi.fn() },
  }
  return { transaction, compliancePackage, prismaTransaction: vi.fn(), persist: vi.fn(), remove: vi.fn(), audit: vi.fn() }
})
vi.mock('server-only', () => ({}))
vi.mock('@/server/persistence/client', () => ({ prisma: { ...mocks.transaction, $transaction: mocks.prismaTransaction } }))
vi.mock('@/server/compliance/objectStorage', () => ({ persistComplianceObject: mocks.persist }))
vi.mock('@/server/storage', () => ({ getDocumentStorage: () => ({ delete: mocks.remove }) }))
vi.mock('@/server/compliance/auditPersistence', () => ({ appendAuditEvent: mocks.audit }))
vi.mock('./runtime', () => ({ ComplianceRuntimeError: class ComplianceRuntimeError extends Error { constructor(message: string, readonly status = 400) { super(message) } } }))

import { approveReportingPackage, createDomainReportingPackage, getReportingOverview, saveProcedureDocument } from './reportingRepository'

describe('reporting compliance repository', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.compliancePackage.findUnique.mockResolvedValue(null)
    mocks.persist.mockResolvedValue('closing-snapshots/tenant-a/package.json')
    mocks.remove.mockResolvedValue(undefined)
    mocks.compliancePackage.findFirst.mockResolvedValue(null)
    mocks.compliancePackage.create.mockImplementation(async ({ data }: { data: unknown }) => data)
    mocks.transaction.retainedArtifact.create.mockResolvedValue({})
    mocks.transaction.fiscalYear.findFirst.mockResolvedValue({ id: 'fy', ownerId: 'tenant-a', year: 2026, startsAt: new Date('2026-01-01T00:00:00Z'), endsAt: new Date('2026-12-31T00:00:00Z') })
    mocks.transaction.fixedAssetRecord.findMany.mockResolvedValue([])
    mocks.transaction.assetEventRecord.findMany.mockResolvedValue([])
    mocks.transaction.inventoryCountSnapshot.findUnique.mockResolvedValue(null)
    mocks.prismaTransaction.mockImplementation(async (work: unknown) => typeof work === 'function' ? (work as (tx: typeof mocks.transaction) => unknown)(mocks.transaction) : Promise.all(work as Promise<unknown>[]))
  })

  it('atomically registers retained deterministic packages and audits creation', async () => {
    const result = await createDomainReportingPackage('tenant-a', 'actor-a', 'ASSET_SCHEDULE', { fiscalPeriodId: 'fy', periodEndsAt: '2099-12-31', reason: 'schedule' })
    expect(result).toMatchObject({ ownerId: 'tenant-a', kind: 'ASSET_SCHEDULE', version: 1, status: 'CREATED' })
    expect(mocks.transaction.retainedArtifact.create).toHaveBeenCalledWith({ data: expect.objectContaining({ ownerId: 'tenant-a', objectType: 'CompliancePackage', retentionClass: 'ACCOUNTING_RECORDS' }) })
    expect(mocks.audit).toHaveBeenCalledWith(mocks.transaction, expect.objectContaining({ ownerId: 'tenant-a', actorId: 'actor-a', action: 'PACKAGE_CREATED' }))
    expect(mocks.transaction.retainedArtifact.create).toHaveBeenCalledWith({ data: expect.objectContaining({ periodEndsAt: new Date('2026-12-31T00:00:00Z') }) })
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it('runs the asset domain generator with the authenticated tenant before persistence', async () => {
    await createDomainReportingPackage('tenant-a', 'actor-a', 'ASSET_SCHEDULE', { assets: [{ tenantId: 'forged' }], fiscalPeriodId: 'fy', reason: 'schedule' })
    expect(mocks.transaction.fixedAssetRecord.findMany).toHaveBeenCalledWith({ where: { ownerId: 'tenant-a' } })
    expect(mocks.compliancePackage.create).toHaveBeenCalledWith({ data: expect.objectContaining({ ownerId: 'tenant-a', kind: 'ASSET_SCHEDULE', payload: expect.stringContaining('"tenantId":"tenant-a"') }) })
  })

  it('binds idempotency to immutable package metadata, not payload bytes alone', async () => {
    await createDomainReportingPackage('tenant-a', 'actor-a', 'ASSET_SCHEDULE', { fiscalPeriodId: 'fy', authorityReference: 'authority-a', reason: 'schedule' })
    await createDomainReportingPackage('tenant-a', 'actor-a', 'ASSET_SCHEDULE', { fiscalPeriodId: 'fy', authorityReference: 'authority-b', reason: 'schedule' })
    const checksums = mocks.compliancePackage.create.mock.calls.map(([argument]) => argument.data.checksum)
    expect(checksums[0]).not.toBe(checksums[1])
  })

  it('hashes the exact retained object bytes while keeping semantic package idempotency', async () => {
    await createDomainReportingPackage('tenant-a', 'actor-a', 'ASSET_SCHEDULE', { fiscalPeriodId: 'fy', authorityReference: 'authority-a', reason: 'schedule' })
    const payload = mocks.compliancePackage.create.mock.calls[0][0].data.payload as string
    const retainedHash = mocks.transaction.retainedArtifact.create.mock.calls[0][0].data.contentHash
    expect(retainedHash).toBe(createHash('sha256').update(Buffer.from(payload)).digest('hex'))
    expect(retainedHash).not.toBe(mocks.compliancePackage.create.mock.calls[0][0].data.checksum)
  })

  it('persists an authenticated inventory close in the package transaction and refuses a second close', async () => {
    mocks.transaction.fiscalYear.findFirst.mockResolvedValue({ id: 'fy-2025', ownerId: 'tenant-a', year: 2025, startsAt: new Date('2025-01-01T00:00:00Z'), endsAt: new Date('2025-12-31T00:00:00Z') })
    mocks.transaction.inventoryItemRecord.findMany.mockResolvedValue([{ payload: JSON.stringify({ id: 'item-1', tenantId: 'tenant-a', sku: 'SKU', description: 'Stock', location: 'Berlin', quantity: 2, unitCostCents: 100 }) }])
    const counts = [{ itemId: 'item-1', countedQuantity: 2, countedBy: 'counter', countedAt: '2025-12-31T12:00:00Z', evidenceIds: ['evidence'], approvedBy: 'approver', approvedAt: '2026-01-01T12:00:00Z' }]
    await createDomainReportingPackage('tenant-a', 'actor-a', 'INVENTORY_CLOSE', { fiscalPeriodId: 'fy-2025', timeZone: 'Europe/Berlin', counts, reason: 'close' })
    expect(mocks.transaction.inventoryCountSnapshot.create).toHaveBeenCalledWith({ data: expect.objectContaining({ ownerId: 'tenant-a', fiscalPeriodId: 'fy-2025', closedBy: 'actor-a', payload: expect.any(String), checksum: expect.any(String) }) })

    mocks.transaction.inventoryCountSnapshot.findUnique.mockResolvedValueOnce({ id: 'closed' })
    await expect(createDomainReportingPackage('tenant-a', 'actor-a', 'INVENTORY_CLOSE', { fiscalPeriodId: 'fy-2025', timeZone: 'Europe/Berlin', counts, reason: 'close again' })).rejects.toThrow(/already closed/)
  })

  it('uses persisted cash-book currency and lets the cash domain reject unsupported currencies', async () => {
    mocks.transaction.cashBookRecord.findFirst.mockResolvedValue({ id: 'cash', ownerId: 'tenant-a', location: 'Berlin', register: 'R1', timeZone: 'Europe/Berlin', currency: 'USD', glAccountId: '1000', retainedThrough: new Date('2036-12-31T00:00:00Z') })
    mocks.transaction.cashEntryRecord.findMany.mockResolvedValue([])
    mocks.transaction.cashCloseRecord.findMany.mockResolvedValue([])
    await expect(createDomainReportingPackage('tenant-a', 'actor-a', 'CASH_AUDIT', { fiscalPeriodId: 'fy', cashBookId: 'cash', reason: 'audit' })).rejects.toThrow(/EUR currency/)
  })

  it('requires annual profile coverage and only loads posted current and comparative journals', async () => {
    mocks.transaction.companyProfileVersion.findFirst.mockResolvedValue(null)
    await expect(createDomainReportingPackage('tenant-a', 'actor-a', 'ANNUAL_ACCOUNTS', { fiscalPeriodId: 'fy', reason: 'annual' })).rejects.toThrow(/profile/)
    expect(mocks.transaction.companyProfileVersion.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ OR: [{ effectiveTo: null }, { effectiveTo: { gte: new Date('2026-12-31T00:00:00Z') } }] }) }))
    expect(mocks.transaction.fiscalYear.findFirst).toHaveBeenCalledWith(expect.objectContaining({ include: { journalEntries: expect.objectContaining({ where: { state: 'POSTED' } }) } }))
  })

  it('selects annual mappings from the effective authoritative profile chart', async () => {
    mocks.transaction.companyProfileVersion.findFirst.mockResolvedValue({ payload: JSON.stringify({ chart: 'SKR04', companyName: 'Example', legalForm: 'GMBH', sizeClass: 'MICRO' }) })
    mocks.transaction.fiscalYear.findFirst
      .mockResolvedValueOnce({ id: 'fy', ownerId: 'tenant-a', year: 2026, startsAt: new Date('2026-01-01T00:00:00Z'), endsAt: new Date('2026-12-31T00:00:00Z') })
      .mockResolvedValueOnce({ id: 'previous', year: 2025, startsAt: new Date('2025-01-01T00:00:00Z'), endsAt: new Date('2025-12-31T00:00:00Z'), journalEntries: [] })
      .mockResolvedValueOnce({ id: 'fy', year: 2026, startsAt: new Date('2026-01-01T00:00:00Z'), endsAt: new Date('2026-12-31T00:00:00Z'), journalEntries: [] })
    mocks.transaction.accountMappingVersion.findMany.mockResolvedValue([])
    await createDomainReportingPackage('tenant-a', 'actor-a', 'ANNUAL_ACCOUNTS', { fiscalPeriodId: 'fy', reason: 'annual', presentation: { checks: { nonOffsetting: true, accrual: true, provisions: true, valuation: true, continuity: true } } }).catch(() => undefined)
    expect(mocks.transaction.accountMappingVersion.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { ownerId: 'tenant-a', chartId: 'SKR04', active: true, effectiveFrom: { lte: new Date('2026-12-31T00:00:00Z') }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: new Date('2026-12-31T00:00:00Z') } }] } }))
    expect(mocks.transaction.fiscalYear.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'fy', ownerId: 'tenant-a' }, include: { journalEntries: expect.objectContaining({ where: { state: 'POSTED' } }) } }))
  })

  it('exports loaded mapping history, including unused mappings, instead of deriving the chart from postings', async () => {
    mocks.transaction.companyProfileVersion.findMany.mockResolvedValue([])
    mocks.transaction.accountMappingVersion.findMany.mockResolvedValue([{ id: 'mapping-unused', ownerId: 'tenant-a', chartId: 'SKR04', accountNumber: 4900, effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveTo: null, accountName: 'Unused', accountType: 'EXPENSE', normalBalance: 'DEBIT', hgbPosition: 'EXPENSE', eBilanzPosition: 'EXPENSE', vatCode: null, active: true }])
    mocks.transaction.fiscalYear.findFirst
      .mockResolvedValueOnce({ id: 'fy', ownerId: 'tenant-a', year: 2026, startsAt: new Date('2026-01-01T00:00:00Z'), endsAt: new Date('2026-12-31T00:00:00Z') })
      .mockResolvedValueOnce({ journalEntries: [] })
    mocks.transaction.auditEvent.findMany.mockResolvedValue([]); mocks.transaction.taxWorkflowRecord.findMany.mockResolvedValue([]); mocks.transaction.cashBookRecord.findMany.mockResolvedValue([]); mocks.transaction.cashEntryRecord.findMany.mockResolvedValue([]); mocks.transaction.cashCloseRecord.findMany.mockResolvedValue([])
    await createDomainReportingPackage('tenant-a', 'actor-a', 'AUDIT_EXPORT', { fiscalPeriodId: 'fy', authorityReference: 'audit-authority', reason: 'audit' })
    const packagePayload = JSON.parse(mocks.compliancePackage.create.mock.calls.at(-1)![0].data.payload)
    expect(packagePayload.files['data/chartMappings.json']).toContain('mapping-unused')
  })

  it('rejects fiscal periods outside the authenticated owner scope', async () => {
    mocks.transaction.fiscalYear.findFirst.mockResolvedValueOnce(null)
    await expect(createDomainReportingPackage('tenant-a', 'actor-a', 'ASSET_SCHEDULE', { fiscalPeriodId: 'tenant-b-fy', reason: 'schedule' })).rejects.toThrow(/not found/)
    expect(mocks.transaction.fiscalYear.findFirst).toHaveBeenCalledWith({ where: { id: 'tenant-b-fy', ownerId: 'tenant-a' }, select: expect.anything() })
    expect(mocks.persist).not.toHaveBeenCalled()
  })

  it('removes an orphaned object when database registration rolls back', async () => {
    mocks.prismaTransaction.mockRejectedValueOnce(new Error('database unavailable'))
    await expect(createDomainReportingPackage('tenant-a', 'actor-a', 'ASSET_SCHEDULE', { fiscalPeriodId: 'fy', reason: 'prepare' })).rejects.toThrow('database unavailable')
    expect(mocks.remove).toHaveBeenCalledWith('closing-snapshots/tenant-a/package.json')
  })

  it('requires independent package approval', async () => {
    mocks.compliancePackage.findFirst.mockResolvedValue({ id: 'package', ownerId: 'tenant-a', status: 'CREATED', createdBy: 'actor-a' })
    await expect(approveReportingPackage('tenant-a', 'actor-a', 'package', 'review')).rejects.toThrow(/Independent/)
    expect(mocks.compliancePackage.update).not.toHaveBeenCalled()
  })

  it('binds procedure approval identity and time to the authenticated actor', async () => {
    const document = { id: 'procedure', version: '1.0.0', effectiveFrom: '2026-01-01', approvedBy: 'forged', approvedAt: '2020-01-01T00:00:00Z', appVersion: '1', configurationVersion: '1', schemaVersion: '1', taxonomyVersions: ['6.9'], sections: Object.fromEntries(['general','user','technical','operations','capture','posting','correction','closing','archiving','reporting','interfaces','access','backup-recovery'].map(key => [key, 'documented'])), controls: Object.fromEntries(['roles-approvals','separation-of-duties','completeness','reconciliation','exception-handling','control-evidence'].map(key => [key, { description: 'documented', ownerRole: 'operator', evidenceReferences: ['evidence'] }])), changeLog: [{ changedAt: '2026-01-01', changedBy: 'actor-a', summary: 'initial' }] }
    mocks.transaction.procedureDocumentRecord.create.mockImplementation(async ({ data }: { data: unknown }) => data)
    await saveProcedureDocument('tenant-a', 'actor-a', { document, confirmApproval: true, reason: 'approve' })
    expect(mocks.transaction.procedureDocumentRecord.create).toHaveBeenCalledWith({ data: expect.objectContaining({ approvedBy: 'actor-a', approvedAt: expect.any(Date) }) })
    await expect(saveProcedureDocument('tenant-a', 'actor-a', { document, reason: 'approve' })).rejects.toThrow(/confirmation/)
  })

  it('applies the authenticated tenant predicate to every reporting collection', async () => {
    for (const repository of [mocks.transaction.compliancePackage, mocks.transaction.procedureDocumentRecord, mocks.transaction.fixedAssetRecord, mocks.transaction.assetEventRecord, mocks.transaction.inventoryItemRecord, mocks.transaction.inventoryCountSnapshot, mocks.transaction.cashBookRecord, mocks.transaction.cashEntryRecord, mocks.transaction.cashCloseRecord]) repository.findMany.mockResolvedValue([])
    await getReportingOverview('tenant-a')
    for (const repository of [mocks.transaction.compliancePackage, mocks.transaction.procedureDocumentRecord, mocks.transaction.fixedAssetRecord, mocks.transaction.assetEventRecord, mocks.transaction.inventoryItemRecord, mocks.transaction.inventoryCountSnapshot, mocks.transaction.cashBookRecord, mocks.transaction.cashEntryRecord, mocks.transaction.cashCloseRecord]) expect(repository.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { ownerId: 'tenant-a' } }))
  })
})
