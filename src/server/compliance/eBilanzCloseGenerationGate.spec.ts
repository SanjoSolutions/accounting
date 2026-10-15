import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ period: vi.fn(), generation: vi.fn(), prepare: vi.fn(), retain: vi.fn(), write: vi.fn(), remove: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/persistence/client', () => ({ prisma: {
  fiscalYear: { findFirst: mocks.period },
  $transaction: (work: (tx: unknown) => unknown) => work({ fiscalYear: { findFirst: mocks.period } }),
} }))
vi.mock('@/server/storage', () => ({ getDocumentStorage: () => ({ write: mocks.write, delete: mocks.remove }) }))
vi.mock('@/server/fiscalCloseGeneration', () => ({ requireCurrentFiscalCloseGeneration: mocks.generation }))
vi.mock('./eBilanzExportRepository', () => ({ prepareAuthoritativeEBalanceExport: mocks.prepare }))
vi.mock('./eBilanzReportStore', () => ({ retainEBalanceReport: mocks.retain }))
vi.mock('./runtime', () => ({ ComplianceRuntimeError: class extends Error {} }))
import { prepareEBalanceLifecycleReport } from './eBilanzRepository'

describe('E-Bilanz lifecycle close-generation gate', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.period.mockResolvedValue({ id: 'fy', startsAt: new Date('2026-04-01'), endsAt: new Date('2027-03-31'), status: 'CLOSED' })
    mocks.generation.mockResolvedValue({ id: 'generation' })
    mocks.prepare.mockResolvedValue({ xml: '<report/>', reportChecksum: 'checksum' })
    mocks.remove.mockResolvedValue(undefined)
    mocks.retain.mockResolvedValue({ created: true, report: { id: 'retained' } })
  })
  test('given an unchanged locked generation, publishes through the shared retention transaction', async () => {
    await expect(prepareEBalanceLifecycleReport('owner', 'actor', { fiscalYearId: 'fy', reason: 'Reviewed' })).resolves.toEqual({ id: 'retained' })
    expect(mocks.generation).toHaveBeenCalledTimes(2)
    expect(mocks.retain).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ ownerId: 'owner', actorId: 'actor', storageChecksum: 'checksum' }))
  })
  test('given a changed close during preparation, refuses publication and removes only staged bytes', async () => {
    mocks.generation.mockResolvedValueOnce({ id: 'generation' }).mockResolvedValueOnce({ id: 'new-generation' })
    await expect(prepareEBalanceLifecycleReport('owner', 'actor', { fiscalYearId: 'fy', reason: 'Reviewed' })).rejects.toThrow('changed')
    expect(mocks.retain).not.toHaveBeenCalled()
    expect(mocks.remove).toHaveBeenCalledWith(mocks.write.mock.calls[0][0])
  })
  test('given a duplicate preparation, returns its original immutable report and cleans up staged bytes', async () => {
    mocks.retain.mockResolvedValue({ created: false, report: { id: 'original' } })
    await expect(prepareEBalanceLifecycleReport('owner', 'actor', { fiscalYearId: 'fy', reason: 'Retry' })).resolves.toEqual({ id: 'original' })
    expect(mocks.remove).toHaveBeenCalledWith(mocks.write.mock.calls[0][0])
  })
})
