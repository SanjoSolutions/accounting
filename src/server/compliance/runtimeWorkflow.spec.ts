import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ draftStatus: 'POSTING', postedEntryId: null as string | null, failAudit: true, finalizeRace: false, transactionCalls: 0 }))
const prismaMock = vi.hoisted(() => ({
  journalDraft: {
    findFirst: vi.fn(async () => ({ id: 'draft', ownerId: 'tenant', status: state.draftStatus, postedEntryId: state.postedEntryId })),
    updateMany: vi.fn(), findUniqueOrThrow: vi.fn(),
  },
  journalEntry: { findUnique: vi.fn(async () => ({ id: 'entry', lines: [], documents: [] })), findFirstOrThrow: vi.fn() },
  compliancePolicy: { findUnique: vi.fn(async () => ({ ownerId: 'tenant', operatorIds: '["operator"]' })) },
  retainedArtifact: { findFirst: vi.fn(), findMany: vi.fn(async () => []) },
  $transaction: vi.fn(),
}))

vi.mock('server-only', () => ({}))
vi.mock('@/server/persistence/client', () => ({ prisma: prismaMock }))
vi.mock('@/server/ledger', () => ({ postJournalEntry: vi.fn(), postJournalCorrection: vi.fn() }))
vi.mock('@/server/storage', () => ({ getDocumentStorage: vi.fn() }))
vi.mock('./objectStorage', () => ({ persistComplianceObject: vi.fn() }))
vi.mock('./restoreVerification', () => ({ verifySnapshotInIsolatedDatabase: vi.fn(), exerciseIsolatedObjectRestore: vi.fn() }))
vi.mock('./auditPersistence', () => ({
  verifyAuditChain: vi.fn(),
  appendAuditEvent: vi.fn(async () => { if (state.failAudit) throw new Error('audit unavailable') }),
}))
import { assertRestoreCertificationPolicy, canonicalPolicyStorageRegions, certifiedRestoreMinutes, createFilingAmendment, disposeArtifact, isCompletedDisposalRetry, isPostingLeaseExpired, mappingChartForDate, mappingResolutionInstant, overviewProfilePayload, postDraft, reconciledDocumentPeriodEnd, recoveryObjectiveWindow, requireOpenDraftPeriod, runDueFixityChecks, shouldClearClosingSnapshot, tombstoneDocumentPayload } from './runtime'

describe('recoverable compliance workflow persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks(); state.draftStatus = 'POSTING'; state.postedEntryId = null; state.failAudit = true; state.finalizeRace = false; state.transactionCalls = 0
    prismaMock.$transaction.mockImplementation(async (callback: (transaction: any) => Promise<unknown>) => {
      state.transactionCalls++
      const before = { status: state.draftStatus, postedEntryId: state.postedEntryId }
      const transaction = { journalDraft: {
        updateMany: vi.fn(async () => { state.draftStatus = 'POSTED'; state.postedEntryId = 'entry'; return { count: state.finalizeRace ? 0 : 1 } }),
        findFirst: vi.fn(async () => ({ status: state.draftStatus, postedEntryId: state.postedEntryId })),
      } }
      try { return await callback(transaction) } catch (error) { state.draftStatus = before.status; state.postedEntryId = before.postedEntryId; throw error }
    })
  })

  it('keeps a posted draft recoverable when audit finalization fails, then reconciles it on retry', async () => {
    await expect(postDraft('tenant', 'operator', 'draft', 'approved')).rejects.toThrow('audit unavailable')
    expect(state.draftStatus).toBe('POSTING')
    state.failAudit = false
    await expect(postDraft('tenant', 'operator', 'draft', 'approved')).resolves.toMatchObject({ id: 'entry' })
    expect(state.draftStatus).toBe('POSTED')
    expect(state.postedEntryId).toBe('entry')
  })
  it('treats a concurrent identical draft finalization as idempotent success', async () => {
    state.failAudit = false; state.finalizeRace = true
    await expect(postDraft('tenant', 'operator', 'draft', 'approved')).resolves.toMatchObject({ id: 'entry' })
    expect(state.draftStatus).toBe('POSTED')
  })

  it('rejects future disposal dates before any deletion transaction can run', async () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
    await expect(disposeArtifact('tenant', 'operator', 'artifact', tomorrow, 'expired')).rejects.toThrow(/Future disposal dates/)
    expect(state.transactionCalls).toBe(0)
  })
  it('expires abandoned posting claims but keeps active claims leased', () => {
    const now = new Date('2026-07-19T12:00:00Z')
    expect(isPostingLeaseExpired(new Date('2026-07-19T11:54:59Z'), now)).toBe(true)
    expect(isPostingLeaseExpired(new Date('2026-07-19T11:59:00Z'), now)).toBe(false)
  })
  it('rejects creation or revision of drafts outside an open fiscal period', () => {
    expect(() => requireOpenDraftPeriod('OPEN')).not.toThrow()
    expect(() => requireOpenDraftPeriod('CLOSED')).toThrow(/open fiscal period/)
    expect(() => requireOpenDraftPeriod('REOPENED')).toThrow(/open fiscal period/)
  })
  it('preserves the operational closing snapshot while a newer retained version survives', () => {
    expect(shouldClearClosingSnapshot(1, [2])).toBe(false)
    expect(shouldClearClosingSnapshot(2, [1])).toBe(true)
  })
  it('resolves mappings with the chart effective on the requested date', () => {
    expect(mappingChartForDate('{"chart":"SKR03"}', true, 'SKR04')).toBe('SKR03')
    expect(mappingChartForDate(undefined, false, 'SKR04')).toBe('SKR04')
    expect(() => mappingChartForDate(undefined, true, 'SKR04')).toThrow(/covers the requested mapping date/)
    expect(mappingResolutionInstant('2026-07-19')).toEqual(new Date('2026-07-19T23:59:59.999Z'))
  })
  it('requires recovery policy jurisdiction to include the configured storage region', () => {
    expect(canonicalPolicyStorageRegions([' DE ', 'DE'], 'DE')).toEqual(['DE'])
    expect(() => canonicalPolicyStorageRegions(['US'], 'DE')).toThrow(/configured storage region DE/)
  })
  it('rejects VAT amendments until a retained original-filing contract exists', async () => {
    await expect(createFilingAmendment('tenant', 'operator', { kind: 'VAT', originalObjectId: 'vat-1', requestPayload: '<xml/>', reason: 'correction' })).rejects.toThrow(/unavailable/)
  })
  it('limits scheduled fixity scans to artifacts with readable storage objects', async () => {
    await expect(runDueFixityChecks('tenant', 'operator', '2026-07-19', 'nightly scan')).resolves.toMatchObject({ checked: 0 })
    expect(prismaMock.retainedArtifact.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ storageKey: { not: null } }) }))
  })
  it('reconciles legacy retention against a referenced or covering deviating period and otherwise retains conservatively', () => {
    expect(reconciledDocumentPeriodEnd(new Date('2027-06-30T23:59:59.999Z'), new Date('2026-12-31'), new Date('2026-07-19'))).toBe('2027-06-30')
    expect(reconciledDocumentPeriodEnd(null, new Date('2027-03-31T23:59:59.999Z'), new Date('2026-07-19'))).toBe('2027-03-31')
    expect(reconciledDocumentPeriodEnd(null, null, new Date('2026-07-19'))).toBe('2027-12-31')
  })
  it('tombstones live document keys while preserving retryable disposal metadata', () => {
    const result = tombstoneDocumentPayload(JSON.stringify({ storageKey: 'document.pdf', thumbnailStorageKey: 'document.webp', thumbnailUrl: '/thumbnail' }), '2036-01-01', 'document.pdf')
    expect(JSON.parse(result.payload)).toMatchObject({ disposedAt: '2036-01-01', disposedStorageKeys: ['document.pdf', 'document.webp'] })
    expect(JSON.parse(result.payload)).not.toHaveProperty('storageKey')
    expect(tombstoneDocumentPayload(result.payload, '2036-01-01', 'document.pdf').storageKeys).toEqual(['document.pdf', 'document.webp'])
  })
  it('recognizes only an identical completed artifact-disposal retry', () => {
    const artifact = { disposedAt: new Date('2036-01-01T23:59:59.999Z'), storageDeletedAt: new Date('2036-01-02T00:00:00Z') }
    expect(isCompletedDisposalRetry(artifact, '2036-01-01')).toBe(true)
    expect(isCompletedDisposalRetry(artifact, '2036-01-02')).toBe(false)
  })
  it('measures RPO from the preceding durable recovery point to this backup completion', () => {
    expect(recoveryObjectiveWindow(
      { recoveryPointAt: new Date('2026-07-19T12:00:00Z'), createdAt: new Date('2026-07-19T12:05:00Z') },
      { recoveryPointAt: new Date('2026-07-19T10:00:00Z') }, new Date('2026-07-01T00:00:00Z'),
    )).toEqual({ recoveryPointAt: '2026-07-19T10:00:00.000Z', referenceAt: '2026-07-19T12:05:00.000Z' })
    expect(recoveryObjectiveWindow(
      { recoveryPointAt: new Date('2026-07-19T12:00:00Z'), createdAt: new Date('2026-07-19T12:05:00Z') }, null, new Date('2026-07-01T00:00:00Z'),
    )).toEqual({ recoveryPointAt: '2026-07-01T00:00:00.000Z', referenceAt: '2026-07-19T12:05:00.000Z' })
    expect(certifiedRestoreMinutes(1, 180_000)).toBe(3)
    expect(certifiedRestoreMinutes(5, 60_000)).toBe(5)
  })
  it('reauthorizes restore certification and applies the current recovery objectives', () => {
    const window = { recoveryPointAt: '2026-07-19T12:00:00.000Z', referenceAt: '2026-07-19T12:05:00.000Z' }
    expect(() => assertRestoreCertificationPolicy({ operatorIds: '["operator"]', recoveryPointObjectiveMinutes: 10, recoveryTimeObjectiveMinutes: 5 }, 'operator', window, 3)).not.toThrow()
    expect(() => assertRestoreCertificationPolicy({ operatorIds: '[]', recoveryPointObjectiveMinutes: 10, recoveryTimeObjectiveMinutes: 5 }, 'operator', window, 3)).toThrow(/no longer an operator/)
    expect(() => assertRestoreCertificationPolicy({ operatorIds: '["operator"]', recoveryPointObjectiveMinutes: 10, recoveryTimeObjectiveMinutes: 2 }, 'operator', window, 3)).toThrow(/RTO/)
  })
  it('does not substitute the cached current profile into a historical version gap', () => {
    expect(overviewProfilePayload(undefined, 2, { companyName: 'Current' })).toBeUndefined()
    expect(overviewProfilePayload(undefined, 0, { companyName: 'Legacy' })).toContain('Legacy')
    expect(overviewProfilePayload('{"companyName":"Historic"}', 2, { companyName: 'Current' })).toContain('Historic')
  })
})
