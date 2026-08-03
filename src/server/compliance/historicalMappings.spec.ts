import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fiscalYear: { findUnique: vi.fn() }, retainedArtifact: { findFirst: vi.fn() }, documentRecord: { findFirst: vi.fn() },
  transaction: { $executeRaw: vi.fn(), accountMappingVersion: { findMany: vi.fn(), create: vi.fn() } }, run: vi.fn(), audit: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/persistence/client', () => ({ prisma: { fiscalYear: mocks.fiscalYear, retainedArtifact: mocks.retainedArtifact, documentRecord: mocks.documentRecord, $transaction: mocks.run } }))
vi.mock('./auditPersistence', () => ({ appendAuditEvent: mocks.audit }))
vi.mock('./runtime', () => ({ ComplianceRuntimeError: class ComplianceRuntimeError extends Error { constructor(message: string, readonly status = 400) { super(message) } } }))

import { createHistoricalMappingsForFiscalYear } from './historicalMappings'

const request = { chartId: 'CUSTOM:HGB-MICRO', size: 'MICRO', method: 'GKV', reason: 'Verified legacy chart', evidenceId: 'evidence-1', mappings: [
  { accountNumber: 1200, name: 'Bank', accountType: 'ASSET' as const, normalBalance: 'DEBIT' as const, presentationSign: 1 as const, hgbPosition: 'BS.A.B', eBilanzPosition: 'cash' },
  { accountNumber: 2900, name: 'Equity', accountType: 'EQUITY' as const, normalBalance: 'CREDIT' as const, presentationSign: 1 as const, hgbPosition: 'BS.P.A', eBilanzPosition: 'equity' },
] }

describe('historical HGB mapping onboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.fiscalYear.findUnique.mockResolvedValue({ id: 'fy-2025', startsAt: new Date('2025-01-01Z'), endsAt: new Date('2025-12-31Z') }); mocks.retainedArtifact.findFirst.mockResolvedValue({ id: 'evidence-1' }); mocks.documentRecord.findFirst.mockResolvedValue(null); mocks.transaction.accountMappingVersion.findMany.mockResolvedValue([]); mocks.transaction.accountMappingVersion.create.mockImplementation(async ({ data }: { data: object }) => data); mocks.run.mockImplementation(async work => work(mocks.transaction))
  })
  it('creates an exact-period evidence-backed cohort with explicit presentation signs', async () => {
    const rows = await createHistoricalMappingsForFiscalYear('tenant-a', 'actor-a', 2025, request, '2026-08-03')
    expect(rows).toHaveLength(2)
    expect(mocks.transaction.accountMappingVersion.create).toHaveBeenCalledWith({ data: expect.objectContaining({ ownerId: 'tenant-a', chartId: 'CUSTOM:HGB-MICRO', effectiveFrom: new Date('2025-01-01Z'), effectiveTo: new Date('2025-12-31Z'), presentationSign: 1 }) })
    expect(mocks.audit).toHaveBeenCalledWith(mocks.transaction, expect.objectContaining({ action: 'HISTORICAL_MAPPING_COHORT_CREATED', after: expect.objectContaining({ evidenceId: 'evidence-1' }) }))
  })
  it('fails closed for non-leaf mappings and overlapping cohorts', async () => {
    await expect(createHistoricalMappingsForFiscalYear('tenant-a', 'actor-a', 2025, { ...request, mappings: [{ ...request.mappings[0], hgbPosition: 'BS.ASSETS' }] }, '2026-08-03')).rejects.toThrow(/account-bearing leaf/)
    await expect(createHistoricalMappingsForFiscalYear('tenant-a', 'actor-a', 2025, { ...request, mappings: [request.mappings[0], { ...request.mappings[1], accountNumber: request.mappings[0].accountNumber }] }, '2026-08-03')).rejects.toThrow(/unique/)
    mocks.transaction.accountMappingVersion.findMany.mockResolvedValue([{ id: 'existing' }])
    await expect(createHistoricalMappingsForFiscalYear('tenant-a', 'actor-a', 2025, request, '2026-08-03')).rejects.toThrow(/overlaps/)
  })
})
