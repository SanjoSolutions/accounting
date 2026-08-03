import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fiscalYear: { findUnique: vi.fn() }, retainedArtifact: { findFirst: vi.fn() }, documentRecord: { findFirst: vi.fn() },
  transaction: { $executeRaw: vi.fn(), companyProfileVersion: { findMany: vi.fn(), create: vi.fn() } }, runTransaction: vi.fn(), audit: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/persistence/client', () => ({ prisma: { fiscalYear: mocks.fiscalYear, retainedArtifact: mocks.retainedArtifact, documentRecord: mocks.documentRecord, $transaction: mocks.runTransaction } }))
vi.mock('./auditPersistence', () => ({ appendAuditEvent: mocks.audit }))
vi.mock('./runtime', () => ({ ComplianceRuntimeError: class ComplianceRuntimeError extends Error { constructor(message: string, readonly status = 400) { super(message) } } }))

import { createHistoricalProfileForFiscalYear } from './historicalProfile'

const profile = { companyName: 'Example GmbH', registeredAddress: { streetAndHouseNumber: 'Test 1', zipCode: '10115', city: 'Berlin', country: 'DE' }, legalForm: 'GMBH', registerCourt: 'Berlin', registerNumber: 'HRB 1', taxNumber: '12/345/67890', taxOffice: 'Berlin', vatRegime: 'STANDARD', vatFilingFrequency: 'MONTHLY', activity: 'Software', sizeClass: 'SMALL', chart: 'SKR03', elections: [] }

describe('historical HGB profile onboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.fiscalYear.findUnique.mockResolvedValue({ id: 'fy-2025', startsAt: new Date('2025-01-01T00:00:00Z'), endsAt: new Date('2025-12-31T23:59:59Z') }); mocks.retainedArtifact.findFirst.mockResolvedValue(null); mocks.documentRecord.findFirst.mockResolvedValue({ id: 'evidence-1' }); mocks.transaction.companyProfileVersion.findMany.mockResolvedValue([]); mocks.transaction.companyProfileVersion.create.mockImplementation(async ({ data }: { data: unknown }) => data); mocks.runTransaction.mockImplementation(async work => work(mocks.transaction))
  })
  it('creates an evidence-backed immutable profile covering the exact completed period and audits provenance', async () => {
    const result = await createHistoricalProfileForFiscalYear('tenant-a', 'actor-a', 2025, { profile, evidenceId: 'evidence-1', reason: 'Verified register extract' }, '2026-08-03')
    expect(result).toMatchObject({ ownerId: 'tenant-a', effectiveFrom: new Date('2025-01-01T00:00:00Z'), effectiveTo: new Date('2025-12-31T23:59:59Z') })
    expect(mocks.audit).toHaveBeenCalledWith(mocks.transaction, expect.objectContaining({ ownerId: 'tenant-a', actorId: 'actor-a', action: 'HISTORICAL_PROFILE_CREATED', after: expect.objectContaining({ evidenceId: 'evidence-1' }) }))
  })
  it('fails closed for current periods, foreign evidence, and overlapping profile history', async () => {
    await expect(createHistoricalProfileForFiscalYear('tenant-a', 'actor-a', 2025, { profile, evidenceId: 'evidence-1', reason: 'x' }, '2025-12-31')).rejects.toThrow(/completed fiscal period/)
    mocks.fiscalYear.findUnique.mockResolvedValue({ id: 'fy', startsAt: new Date('2024-01-01Z'), endsAt: new Date('2024-12-31Z') }); mocks.documentRecord.findFirst.mockResolvedValue(null)
    await expect(createHistoricalProfileForFiscalYear('tenant-a', 'actor-a', 2024, { profile, evidenceId: 'foreign', reason: 'x' }, '2026-08-03')).rejects.toThrow(/outside/)
    mocks.documentRecord.findFirst.mockResolvedValue({ id: 'evidence-1' }); mocks.transaction.companyProfileVersion.findMany.mockResolvedValue([{ id: 'existing', effectiveFrom: new Date('2024-01-01Z'), effectiveTo: null, payload: '{}' }])
    await expect(createHistoricalProfileForFiscalYear('tenant-a', 'actor-a', 2024, { profile, evidenceId: 'evidence-1', reason: 'x' }, '2026-08-03')).rejects.toThrow(/overlaps/)
  })
})
