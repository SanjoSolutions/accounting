import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hgbWorkpaperChecksum, validateHgbWorkpaper, type HgbWorkpaperDraft } from '@/core/hgbWorkpapers'

const mocks = vi.hoisted(() => {
  const transaction = { hgbWorkpaperRecord: { update: vi.fn() }, hgbAdjustmentRecord: { create: vi.fn() } }
  return {
    transaction,
    prisma: {
      fiscalYear: { findUnique: vi.fn(), findFirst: vi.fn() }, hgbWorkpaperRecord: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
      hgbAdjustmentRecord: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
      documentRecord: { findMany: vi.fn() }, retainedArtifact: { findMany: vi.fn() }, journalEntry: { findUnique: vi.fn() },
      $transaction: vi.fn(async (callback: (client: unknown) => unknown) => callback(transaction)),
    },
    appendAuditEvent: vi.fn(), postJournalEntry: vi.fn(),
  }
})

vi.mock('server-only', () => ({}))
vi.mock('@/server/persistence/client', () => ({ prisma: mocks.prisma }))
vi.mock('@/server/compliance/auditPersistence', () => ({ appendAuditEvent: mocks.appendAuditEvent }))
vi.mock('@/server/ledger', () => ({ postJournalEntry: mocks.postJournalEntry }))
vi.mock('@/server/compliance/runtime', () => ({ ComplianceRuntimeError: class ComplianceRuntimeError extends Error { constructor(message: string, public status = 400) { super(message) } } }))

import { listHgbWorkpapers, postHgbAdjustment, prepareHgbWorkpaper, reviewHgbWorkpaper, saveHgbWorkpaper } from './hgbWorkpaperRepository'

const fiscalPeriod = { id: 'fy-2026', ownerId: 'tenant-a', year: 2026, startsAt: new Date('2026-01-01T00:00:00Z'), endsAt: new Date('2026-12-31T23:59:59Z'), status: 'OPEN' }
const input: HgbWorkpaperDraft = {
  kind: 'CUT_OFF_AND_ACCRUAL_DEFERRAL', title: 'Cut-off', conclusion: 'COMPLETE', evidenceIds: ['population'],
  adjustments: [{ id: 'adj-1', bookingDate: '2026-12-31', description: 'Accrual', evidenceIds: ['calculation'], lines: [{ accountId: 'expense', debitCents: 100, creditCents: 0 }, { accountId: 'liability', debitCents: 0, creditCents: 100 }] }],
  schedule: { type: 'CUT_OFF_ACCRUAL_DEFERRAL', applicability: 'APPLICABLE', rationale: 'Year-end sample', testedBeforeThrough: '2026-12-31', testedAfterThrough: '2027-01-31', populationEvidenceId: 'population', exceptionsResolved: true, items: [{ id: 'a', category: 'ACCRUED_EXPENSE', serviceFrom: '2026-01-01', serviceThrough: '2026-12-31', amountCents: 100, calculationEvidenceId: 'calculation', proposalId: 'adj-1' }] },
}
const validated = validateHgbWorkpaper(input, { startsAt: '2026-01-01', endsAt: '2026-12-31' })
const checksum = hgbWorkpaperChecksum({ ownerId: 'tenant-a', fiscalPeriodId: 'fy-2026', kind: input.kind, payload: validated })
const record = { id: 'wp-1', ownerId: 'tenant-a', fiscalPeriodId: 'fy-2026', kind: input.kind, version: 1, status: 'DRAFT', ruleSetVersion: 'HGB-DE-2024.1', payload: JSON.stringify(validated), checksum, preparedBy: null }

describe('HGB workpaper repository', () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.prisma.fiscalYear.findUnique.mockResolvedValue(fiscalPeriod); mocks.prisma.fiscalYear.findFirst.mockResolvedValue(fiscalPeriod)
    mocks.prisma.hgbWorkpaperRecord.findFirst.mockResolvedValue(null); mocks.prisma.hgbWorkpaperRecord.create.mockImplementation(async ({ data }: { data: object }) => data)
    mocks.prisma.documentRecord.findMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map(id => ({ id })))
    mocks.prisma.retainedArtifact.findMany.mockResolvedValue([]); mocks.prisma.journalEntry.findUnique.mockResolvedValue(null)
  })

  it('creates a tenant- and fiscal-period-scoped typed draft with an authoritative checksum', async () => {
    const saved = await saveHgbWorkpaper('tenant-a', 'preparer', 2026, input)
    expect(saved).toMatchObject({ ownerId: 'tenant-a', fiscalPeriodId: 'fy-2026', version: 1, status: 'DRAFT', checksum })
    expect(mocks.prisma.hgbWorkpaperRecord.create).toHaveBeenCalledWith({ data: expect.objectContaining({ createdBy: 'preparer', ruleSetVersion: 'HGB-DE-2024.1' }) })
  })

  it('uses optimistic checksums when editing a current draft and leaves reviewed versions immutable', async () => {
    mocks.prisma.hgbWorkpaperRecord.findFirst.mockResolvedValue(record)
    await expect(saveHgbWorkpaper('tenant-a', 'preparer', 2026, input, 'stale')).rejects.toThrow(/draft changed/)
    mocks.prisma.hgbWorkpaperRecord.update.mockResolvedValue(record)
    await expect(saveHgbWorkpaper('tenant-a', 'preparer', 2026, input, checksum)).resolves.toMatchObject({ id: 'wp-1' })
    mocks.prisma.hgbWorkpaperRecord.findFirst.mockResolvedValue({ ...record, status: 'REVIEWED' })
    await saveHgbWorkpaper('tenant-a', 'preparer', 2026, input)
    expect(mocks.prisma.hgbWorkpaperRecord.create).toHaveBeenLastCalledWith({ data: expect.objectContaining({ version: 2, supersedesId: 'wp-1' }) })
  })

  it('fails preparation closed when any evidence is missing or belongs elsewhere', async () => {
    mocks.prisma.hgbWorkpaperRecord.findFirst.mockResolvedValue(record); mocks.prisma.documentRecord.findMany.mockResolvedValue([{ id: 'population' }])
    await expect(prepareHgbWorkpaper('tenant-a', 'preparer', 'wp-1', checksum)).rejects.toThrow(/calculation/)
  })

  it('prepares only checksum-valid work and creates posting records only after independent approval', async () => {
    mocks.prisma.hgbWorkpaperRecord.findFirst.mockResolvedValue(record); mocks.prisma.hgbWorkpaperRecord.update.mockResolvedValue({ ...record, status: 'PREPARED', preparedBy: 'preparer' })
    await expect(prepareHgbWorkpaper('tenant-a', 'preparer', 'wp-1', checksum)).resolves.toMatchObject({ status: 'PREPARED' })
    mocks.prisma.hgbWorkpaperRecord.findFirst.mockResolvedValue({ ...record, status: 'PREPARED', preparedBy: 'preparer' }); mocks.transaction.hgbWorkpaperRecord.update.mockResolvedValue({ ...record, status: 'REVIEWED' }); mocks.transaction.hgbAdjustmentRecord.create.mockResolvedValue({})
    await expect(reviewHgbWorkpaper('tenant-a', 'preparer', 'wp-1', 'APPROVE')).rejects.toThrow(/distinct/)
    await reviewHgbWorkpaper('tenant-a', 'reviewer', 'wp-1', 'APPROVE')
    expect(mocks.transaction.hgbAdjustmentRecord.create).toHaveBeenCalledWith({ data: expect.objectContaining({ proposalId: 'adj-1', fingerprint: validated.adjustments[0].fingerprint }) })
  })

  it('posts a reviewed balanced proposal with a stable external key and recovers idempotently', async () => {
    const reviewed = { ...record, status: 'REVIEWED' }; const adjustmentRecord = { id: 'posting-1', ownerId: 'tenant-a', fiscalPeriodId: 'fy-2026', workpaperId: 'wp-1', proposalId: 'adj-1', fingerprint: validated.adjustments[0].fingerprint, status: 'PROPOSED', idempotencyKey: null, payload: JSON.stringify(validated.adjustments[0]) }
    mocks.prisma.hgbWorkpaperRecord.findFirst.mockResolvedValue(reviewed); mocks.prisma.hgbAdjustmentRecord.findFirst.mockResolvedValue(adjustmentRecord); mocks.prisma.hgbAdjustmentRecord.findUnique.mockResolvedValue(null); mocks.prisma.hgbAdjustmentRecord.update.mockImplementation(async ({ data }: { data: object }) => ({ ...adjustmentRecord, ...data })); mocks.postJournalEntry.mockResolvedValue({ id: 'entry-1' })
    const result = await postHgbAdjustment('tenant-a', 'poster', 2026, 'wp-1', 'adj-1', 'request-1')
    expect(result).toMatchObject({ status: 'POSTED', postedEntryId: 'entry-1' })
    expect(mocks.postJournalEntry).toHaveBeenCalledWith('tenant-a', expect.objectContaining({ documentNumber: 'SYS-HGB-posting-1', lines: validated.adjustments[0].lines }), 'HGB_CLOSE', expect.objectContaining({ externalKey: `hgb-adjustment:posting-1:${validated.adjustments[0].fingerprint}` }))
    mocks.prisma.journalEntry.findUnique.mockResolvedValue({ id: 'entry-1' })
    await postHgbAdjustment('tenant-a', 'poster', 2026, 'wp-1', 'adj-1', 'request-1')
    expect(mocks.postJournalEntry).toHaveBeenCalledTimes(1)
  })

  it('returns only latest typed versions with their posting links for UI consumption', async () => {
    mocks.prisma.hgbWorkpaperRecord.findMany.mockResolvedValue([{ ...record, version: 2 }, record]); mocks.prisma.hgbAdjustmentRecord.findMany.mockResolvedValue([{ id: 'a', workpaperId: 'wp-1', proposalId: 'adj-1', payload: JSON.stringify(validated.adjustments[0]) }])
    const result = await listHgbWorkpapers('tenant-a', 2026)
    expect(result.fiscalPeriod).toMatchObject({ id: 'fy-2026', status: 'OPEN' }); expect(result.workpapers).toHaveLength(1); expect(result.workpapers[0].payload.schedule.type).toBe('CUT_OFF_ACCRUAL_DEFERRAL')
  })
})
