import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sha256 } from './compliance/retention'

const mocks = vi.hoisted(() => ({ findFirst: vi.fn(), create: vi.fn(), requireReady: vi.fn() }))

vi.mock('server-only', () => ({}))
vi.mock('./hgbCloseRepository', () => ({ requireCurrentReadyHgbClose: mocks.requireReady }))

import { createFiscalCloseGeneration, requireCurrentFiscalCloseGeneration } from './fiscalCloseGeneration'

const lockedAt = new Date('2026-01-31T12:00:00.000Z')
const closingSnapshot = JSON.stringify({ netIncomeCents: 100, closedAt: lockedAt.toISOString() })
const hgbCloseRun = { id: 'hgb-1', ownerId: 'tenant-a', fiscalPeriodId: 'fy-2025', status: 'READY_TO_LOCK', checksum: 'hgb-hash' }

describe('fiscal close generations', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.requireReady.mockResolvedValue(hgbCloseRun) })

  it('creates the next immutable generation bound to the exact HGB run and snapshot', async () => {
    mocks.findFirst.mockResolvedValue({ generation: 1 })
    mocks.create.mockImplementation(async ({ data }: { data: unknown }) => data)
    const transaction = { fiscalCloseGeneration: mocks } as never

    const result = await createFiscalCloseGeneration(transaction, 'tenant-a', 'fy-2025', hgbCloseRun, closingSnapshot, lockedAt)

    expect(result).toMatchObject({ ownerId: 'tenant-a', fiscalYearId: 'fy-2025', generation: 2, hgbCloseRunId: 'hgb-1', hgbCloseRunChecksum: 'hgb-hash', snapshotHash: sha256(closingSnapshot), lockedAt })
  })

  it('accepts only the generation matching the current lock instant, snapshot and HGB checksum', async () => {
    const generation = { id: 'close-1', ownerId: 'tenant-a', fiscalYearId: 'fy-2025', generation: 1, hgbCloseRunId: 'hgb-1', lockedAt, snapshotHash: sha256(closingSnapshot), hgbCloseRunChecksum: 'hgb-hash', hgbCloseRun }
    mocks.findFirst.mockResolvedValue(generation)
    const client = { fiscalCloseGeneration: mocks } as never
    const fiscalYear = { id: 'fy-2025', year: 2025, status: 'CLOSED', lockedAt, closingSnapshot }

    await expect(requireCurrentFiscalCloseGeneration(client, 'tenant-a', fiscalYear)).resolves.toBe(generation)
    await expect(requireCurrentFiscalCloseGeneration(client, 'tenant-a', { ...fiscalYear, closingSnapshot: '{}' })).rejects.toThrow(/missing, stale/)
    mocks.findFirst.mockResolvedValue({ ...generation, hgbCloseRunChecksum: 'different' })
    await expect(requireCurrentFiscalCloseGeneration(client, 'tenant-a', fiscalYear)).rejects.toThrow(/missing, stale/)
  })

  it('fails closed for open or reopened periods before querying generation history', async () => {
    const client = { fiscalCloseGeneration: mocks } as never
    await expect(requireCurrentFiscalCloseGeneration(client, 'tenant-a', { id: 'fy-2025', year: 2025, status: 'REOPENED', lockedAt, closingSnapshot })).rejects.toThrow(/currently locked/)
    expect(mocks.findFirst).not.toHaveBeenCalled()
  })

  it('safely remediates a legacy closed year only after the current authoritative HGB gate succeeds', async () => {
    const generation = { id: 'close-legacy', ownerId: 'tenant-a', fiscalYearId: 'fy-2025', generation: 1, hgbCloseRunId: 'hgb-1', lockedAt, snapshotHash: sha256(closingSnapshot), hgbCloseRunChecksum: 'hgb-hash', hgbCloseRun }
    mocks.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(generation)
    mocks.create.mockResolvedValue(generation)
    const client = { fiscalCloseGeneration: mocks } as never

    await expect(requireCurrentFiscalCloseGeneration(client, 'tenant-a', { id: 'fy-2025', year: 2025, status: 'CLOSED', lockedAt, closingSnapshot })).resolves.toBe(generation)
    expect(mocks.requireReady).toHaveBeenCalledWith(client, 'tenant-a', { id: 'fy-2025', year: 2025 })
    expect(mocks.create).toHaveBeenCalled()
  })

  it('rejects a stored generation when the authoritative current HGB run changed', async () => {
    const generation = { id: 'close-1', ownerId: 'tenant-a', fiscalYearId: 'fy-2025', generation: 1, hgbCloseRunId: 'hgb-1', lockedAt, snapshotHash: sha256(closingSnapshot), hgbCloseRunChecksum: 'hgb-hash', hgbCloseRun }
    mocks.findFirst.mockResolvedValue(generation)
    mocks.requireReady.mockResolvedValue({ ...hgbCloseRun, id: 'hgb-current', checksum: 'current-hash' })
    const client = { fiscalCloseGeneration: mocks } as never

    await expect(requireCurrentFiscalCloseGeneration(client, 'tenant-a', { id: 'fy-2025', year: 2025, status: 'CLOSED', lockedAt, closingSnapshot })).rejects.toThrow(/missing, stale/)
  })
})
