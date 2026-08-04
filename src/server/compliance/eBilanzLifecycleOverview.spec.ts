import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  taxonomyFindMany: vi.fn(), reportFindMany: vi.fn(), reconciliationFindMany: vi.fn(), fiscalYearFindFirst: vi.fn(), currentGeneration: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/persistence/client', () => ({ prisma: {
  $transaction: (requests: Promise<unknown>[]) => Promise.all(requests),
  eBalanceTaxonomyRelease: { findMany: mocks.taxonomyFindMany }, eBalanceLifecycleReport: { findMany: mocks.reportFindMany },
  eBalanceReconciliationRecord: { findMany: mocks.reconciliationFindMany }, fiscalYear: { findFirst: mocks.fiscalYearFindFirst },
} }))
vi.mock('@/server/fiscalCloseGeneration', () => ({ requireCurrentFiscalCloseGeneration: mocks.currentGeneration }))

import { getEBalanceLifecycleOverview } from './eBilanzRepository'

const taxonomy = { version: '6.9', validFrom: new Date('2025-01-01'), validThrough: new Date('2026-12-31'), gaapNamespace: 'gaap', gcdNamespace: 'gcd', entryPoint: 'entry.xsd', archiveSha256: 'a'.repeat(64), successorVersion: null }
const fiscalYear = { id: 'fy-2026', year: 2026, status: 'CLOSED', lockedAt: new Date('2027-01-01'), closingSnapshot: '{}' }

describe('persisted E-Bilanz lifecycle overview', () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.taxonomyFindMany.mockResolvedValue([taxonomy]); mocks.reconciliationFindMany.mockResolvedValue([])
    mocks.fiscalYearFindFirst.mockResolvedValue(fiscalYear); mocks.currentGeneration.mockResolvedValue({ id: 'generation-current' })
  })

  it('labels only the newest report bound to the exact current locked-close generation as current', async () => {
    mocks.reportFindMany.mockResolvedValue([
      { id: 'new', fiscalYearId: 'fy-2026', closeGenerationId: 'generation-current' },
      { id: 'superseded', fiscalYearId: 'fy-2026', closeGenerationId: 'generation-current' },
      { id: 'old', fiscalYearId: 'fy-2026', closeGenerationId: 'generation-old' },
    ])
    await expect(getEBalanceLifecycleOverview('tenant-a', 'fy-2026')).resolves.toMatchObject({
      closeEvidence: { sourceStatus: 'CURRENT', currentCloseGenerationId: 'generation-current', issue: null },
      reports: [{ id: 'new', sourceStatus: 'CURRENT' }, { id: 'superseded', sourceStatus: 'STALE' }, { id: 'old', sourceStatus: 'STALE' }],
    })
    expect(mocks.fiscalYearFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'fy-2026', ownerId: 'tenant-a' } }))
  })

  it('fails the visible evidence state closed when authoritative close verification rejects staleness', async () => {
    mocks.reportFindMany.mockResolvedValue([{ id: 'report', fiscalYearId: 'fy-2026', closeGenerationId: 'generation-old' }])
    mocks.currentGeneration.mockRejectedValue(new Error('The fiscal close generation is stale.'))
    await expect(getEBalanceLifecycleOverview('tenant-a', 'fy-2026')).resolves.toMatchObject({
      closeEvidence: { sourceStatus: 'STALE', currentCloseGenerationId: null, issue: 'The fiscal close generation is stale.' },
      reports: [{ id: 'report', sourceStatus: 'STALE' }],
    })
  })

  it('does not expose a foreign tenant fiscal period or its report evidence', async () => {
    mocks.reportFindMany.mockResolvedValue([]); mocks.fiscalYearFindFirst.mockResolvedValue(null)
    await expect(getEBalanceLifecycleOverview('tenant-a', 'foreign-fy')).resolves.toMatchObject({ reports: [], reconciliations: [], closeEvidence: null })
    expect(mocks.currentGeneration).not.toHaveBeenCalled()
  })
})
