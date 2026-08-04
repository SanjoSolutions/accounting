import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HGB_WORKPAPER_KINDS } from '@/core/hgbClose'

const mocks = vi.hoisted(() => {
  const fiscalYear = { findUnique: vi.fn() }
  const companyProfileVersion = { findFirst: vi.fn() }
  const accountMappingVersion = { findMany: vi.fn() }
  const retainedArtifact = { findMany: vi.fn() }
  const documentRecord = { findMany: vi.fn() }
  const hgbWorkpaperRecord = { findMany: vi.fn() }
  const hgbAdjustmentRecord = { findMany: vi.fn() }
  const compliancePackage = { findFirst: vi.fn(), findMany: vi.fn() }
  const transaction = {
    hgbCloseRun: { findFirst: vi.fn(), create: vi.fn() },
    fiscalYear, companyProfileVersion, accountMappingVersion, retainedArtifact, documentRecord, compliancePackage, hgbWorkpaperRecord, hgbAdjustmentRecord,
    auditHead: { upsert: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() },
    auditEvent: { create: vi.fn() },
  }
  return {
    transaction,
    prisma: {
      fiscalYear, companyProfileVersion, accountMappingVersion, retainedArtifact, documentRecord, hgbWorkpaperRecord, hgbAdjustmentRecord,
      compliancePackage, hgbCloseRun: { findMany: vi.fn(), findUnique: vi.fn() },
      $transaction: vi.fn(async (callback: (transaction: unknown) => unknown) => callback(transaction)),
    },
    appendAuditEvent: vi.fn(),
  }
})

vi.mock('server-only', () => ({}))
vi.mock('@/server/persistence/client', () => ({ prisma: mocks.prisma }))
vi.mock('@/server/compliance/auditPersistence', () => ({ appendAuditEvent: mocks.appendAuditEvent }))
vi.mock('@/server/compliance/runtime', () => ({ ComplianceRuntimeError: class ComplianceRuntimeError extends Error { constructor(message: string, public status = 400) { super(message) } } }))
vi.mock('@/core/hgbWorkpapers', () => ({ validateHgbWorkpaper: (value: unknown) => value, hgbWorkpaperChecksum: () => 'trusted-checksum' }))

import { evaluateAndPersistHgbClose, getHgbCloseRuns, hgbCloseFingerprint, requireCurrentReadyHgbClose } from './hgbCloseRepository'

const period = {
  id: 'fy-2026', ownerId: 'tenant-a', year: 2026, startsAt: new Date('2026-01-01T00:00:00.000Z'), endsAt: new Date('2026-12-31T23:59:59.999Z'),
  journalEntries: [{ id: 'entry-1', sequenceNumber: 1, bookingDate: new Date('2026-01-02T00:00:00.000Z'), state: 'POSTED', lines: [{ id: 'line-1', accountId: 'account-1', debitCents: 100, creditCents: 0 }] }],
}
const profileVersion = { id: 'profile-1', ownerId: 'tenant-a', effectiveFrom: new Date('2026-01-01T00:00:00.000Z'), effectiveTo: null, payload: JSON.stringify({ legalForm: 'GMBH', chart: 'SKR03', registeredAddress: { country: 'DE' } }) }
const mappings = [{ id: 'mapping-1', ownerId: 'tenant-a', chartId: 'SKR03', accountNumber: 1000, effectiveFrom: new Date('2026-01-01T00:00:00.000Z'), effectiveTo: null, accountName: 'Cash', accountType: 'ASSET', normalBalance: 'DEBIT', hgbPosition: 'A.CASH', eBilanzPosition: 'cash', vatCode: null, active: true }]

function requestProfile() {
  return {
    legalForm: 'CALLER_FORM', fiscalPeriodStart: '1999-01-01', fiscalPeriodEnd: '1999-12-31', germanRegisteredEntity: false,
    groupStatus: 'STANDALONE_NO_EXEMPTION', publicInterestEntity: false, capitalMarketOrListed: false, regulatedIndustry: false, liquidationOrInsolvencyBasis: false, goingConcern: true,
    formedOrConvertedInCurrentPeriod: false, section5aApplies: false,
    currentSizeFacts: { balanceSheetTotalCents: 100, revenueCents: 100, quarterlyEmployeeCounts: [1, 1, 1, 1], microExcludedBySection267a: false },
    priorSizeFacts: { balanceSheetTotalCents: 100, revenueCents: 100, quarterlyEmployeeCounts: [1, 1, 1, 1], microExcludedBySection267a: false }, priorEstablishedSize: 'MICRO', hasInventory: false, hasFixedAssets: false,
    microNotesOmission: { requiredSection268Paragraph7DisclosuresIncludedBelowBalanceSheet: true, advancesAndLoansToManagementDisclosedBelowBalanceSheet: true, requiredAdditionalTrueAndFairDisclosuresIncludedBelowBalanceSheet: true },
  }
}

function readyRequest() {
  const excluded = new Set(['FIXED_ASSETS_AND_DEPRECIATION', 'INVENTORY_COUNT_AND_VALUATION', 'NOTES'])
  return {
    reason: 'Year-end evaluation', profile: requestProfile(),
    workpapers: HGB_WORKPAPER_KINDS.filter(kind => !excluded.has(kind)).map(kind => ({ kind, conclusion: 'COMPLETE', evidenceIds: [`evidence-${kind}`], preparedBy: 'preparer', reviewedBy: 'reviewer', reviewedAt: '2027-01-15T10:00:00.000Z' })),
    annualAccountsPackageId: 'annual-1', annualAccountsChecksum: 'a'.repeat(64), legalRepresentativeIds: ['director-1'], managingDirectorSignatures: [{ representativeId: 'director-1', signedAt: '2027-01-15T11:00:00.000Z', signatureEvidenceId: 'signature-1' }], shareholderResolutionId: 'resolution-1',
  }
}

function reviewedWorkpapers() {
  const excluded = new Set(['FIXED_ASSETS_AND_DEPRECIATION', 'INVENTORY_COUNT_AND_VALUATION', 'NOTES'])
  return HGB_WORKPAPER_KINDS.filter(kind => !excluded.has(kind)).map(kind => ({
    id: `workpaper-${kind}`, ownerId: 'tenant-a', fiscalPeriodId: 'fy-2026', kind, version: 1, status: 'REVIEWED', ruleSetVersion: 'HGB-DE-2024.1',
    payload: JSON.stringify({ kind, conclusion: 'COMPLETE', evidenceIds: [`evidence-${kind}`], ...(kind === 'SIZE_AND_APPLICABILITY' ? { schedule: { closeProfile: requestProfile() } } : {}), ...(kind === 'GMBH_EQUITY_AND_RESULT' ? { schedule: { section5aReserveApplicable: false } } : {}) }), checksum: 'trusted-checksum',
    preparedBy: 'preparer', reviewedBy: 'reviewer', reviewedAt: new Date('2027-01-15T10:00:00.000Z'), reviewReason: null,
  }))
}

describe('HGB close run repository', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.prisma.fiscalYear.findUnique.mockResolvedValue(period)
    mocks.prisma.companyProfileVersion.findFirst.mockResolvedValue(profileVersion)
    mocks.prisma.accountMappingVersion.findMany.mockResolvedValue(mappings)
    mocks.prisma.hgbWorkpaperRecord.findMany.mockResolvedValue(reviewedWorkpapers())
    mocks.prisma.hgbAdjustmentRecord.findMany.mockResolvedValue([])
    mocks.prisma.retainedArtifact.findMany.mockResolvedValue([])
    mocks.prisma.documentRecord.findMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map(id => ({ id, payload: JSON.stringify({ evidence: id }) })))
    mocks.prisma.compliancePackage.findFirst.mockResolvedValue(null)
    mocks.prisma.compliancePackage.findMany.mockResolvedValue([])
    mocks.prisma.hgbCloseRun.findUnique.mockResolvedValue(null)
    mocks.transaction.hgbCloseRun.findFirst.mockResolvedValue(null)
    mocks.transaction.hgbCloseRun.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...data, createdAt: new Date('2027-01-15T12:00:00.000Z') }))
  })

  it('produces an order-independent canonical fingerprint and detects ledger changes', () => {
    const input = { fiscalPeriod: period, profileVersion, mappings, entries: period.journalEntries }
    const first = hgbCloseFingerprint(input)
    expect(hgbCloseFingerprint({ ...input, entries: [{ ...period.journalEntries[0], lines: [...period.journalEntries[0].lines].reverse() }] })).toBe(first)
    expect(hgbCloseFingerprint({ ...input, entries: [{ ...period.journalEntries[0], lines: [{ ...period.journalEntries[0].lines[0], debitCents: 101 }] }] })).not.toBe(first)
  })

  it('makes a new authoritative profile cohort stale even when ledger entries are unchanged', () => {
    const input = { fiscalPeriod: period, profileVersion, mappings, entries: period.journalEntries }
    const changedProfile = { ...profileVersion, id: 'profile-2', effectiveFrom: new Date('2026-08-04T00:00:00Z'), payload: JSON.stringify({ ...JSON.parse(profileVersion.payload), registeredAddress: { streetAndHouseNumber: 'Test 1', zipCode: '10115', city: 'Berlin-Mitte', country: 'DE' } }) }
    expect(hgbCloseFingerprint({ ...input, profileVersion: changedProfile })).not.toBe(hgbCloseFingerprint(input))
  })

  it('overwrites caller legal-form and period claims with authoritative records and persists a ready immutable run', async () => {
    mocks.prisma.compliancePackage.findFirst.mockResolvedValue({ id: 'annual-1' })
    const result = await evaluateAndPersistHgbClose('tenant-a', 'actor-a', 2026, readyRequest())
    expect(result.status).toBe('READY_TO_LOCK')
    const create = mocks.transaction.hgbCloseRun.create.mock.calls[0][0].data
    const payload = JSON.parse(create.payload)
    expect(payload.input.profile).toMatchObject({ legalForm: 'GMBH', fiscalPeriodStart: '2026-01-01', fiscalPeriodEnd: '2026-12-31', germanRegisteredEntity: true })
    expect(mocks.prisma.fiscalYear.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { ownerId_year: { ownerId: 'tenant-a', year: 2026 } } }))
    expect(mocks.prisma.companyProfileVersion.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ ownerId: 'tenant-a' }) }))
    expect(mocks.appendAuditEvent).toHaveBeenCalledWith(mocks.transaction, expect.objectContaining({ ownerId: 'tenant-a', actorId: 'actor-a', action: 'HGB_CLOSE_EVALUATED', objectType: 'HgbCloseRun' }))
  })

  it('persists blocked evaluations when an annual package is outside the authoritative tenant or period', async () => {
    mocks.prisma.compliancePackage.findFirst.mockResolvedValue(null)
    const result = await evaluateAndPersistHgbClose('tenant-a', 'actor-a', 2026, readyRequest())
    expect(result.status).toBe('BLOCKED')
    expect((result.payload as { readiness: { blockers: unknown[] } }).readiness.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'ANNUAL_ACCOUNTS_PACKAGE_NOT_AUTHORITATIVE' })]))
    expect(mocks.prisma.compliancePackage.findFirst).toHaveBeenCalledWith({ where: expect.objectContaining({ ownerId: 'tenant-a', fiscalPeriodId: 'fy-2026', status: 'APPROVED' }) })
  })

  it('persists a blocked run when the reviewed equity workpaper contradicts the authoritative UG section 5a profile', async () => {
    mocks.prisma.companyProfileVersion.findFirst.mockResolvedValue({ ...profileVersion, payload: JSON.stringify({ legalForm: 'UG', chart: 'SKR03', registeredAddress: { country: 'DE' } }) })
    mocks.prisma.compliancePackage.findFirst.mockResolvedValue({ id: 'annual-1' })
    mocks.prisma.hgbWorkpaperRecord.findMany.mockResolvedValue(reviewedWorkpapers().map(workpaper => workpaper.kind === 'SIZE_AND_APPLICABILITY'
      ? { ...workpaper, payload: JSON.stringify({ kind: workpaper.kind, conclusion: 'COMPLETE', evidenceIds: [`evidence-${workpaper.kind}`], schedule: { closeProfile: { ...requestProfile(), section5aApplies: true } } }) }
      : workpaper))

    const result = await evaluateAndPersistHgbClose('tenant-a', 'actor-a', 2026, readyRequest())

    expect(result.status).toBe('BLOCKED')
    expect((result.payload as { readiness: { blockers: unknown[] } }).readiness.blockers).toContainEqual(expect.objectContaining({ code: 'SECTION_5A_APPLICABILITY_MISMATCH' }))
  })

  it('tenant-scopes run history to the resolved authoritative fiscal period', async () => {
    mocks.prisma.hgbCloseRun.findMany.mockResolvedValue([])
    mocks.prisma.compliancePackage.findMany.mockResolvedValue([{ id: 'annual-1', version: 2, checksum: 'a'.repeat(64), approvedAt: new Date('2027-01-15T11:00:00.000Z') }])
    const result = await getHgbCloseRuns('tenant-a', 2026)
    expect(result.fiscalPeriod.id).toBe('fy-2026')
    expect(result.approvedAnnualPackages).toEqual([expect.objectContaining({ id: 'annual-1', version: 2 })])
    expect(mocks.prisma.hgbCloseRun.findMany).toHaveBeenCalledWith({ where: { ownerId: 'tenant-a', fiscalPeriodId: 'fy-2026' }, orderBy: { version: 'desc' } })
    expect(mocks.prisma.compliancePackage.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { ownerId: 'tenant-a', fiscalPeriodId: 'fy-2026', kind: 'ANNUAL_ACCOUNTS', status: 'APPROVED' } }))
  })

  it('recomputes the authoritative fingerprint inside the lock transaction and rejects stale runs', async () => {
    mocks.prisma.compliancePackage.findFirst.mockResolvedValue({ id: 'annual-1', status: 'APPROVED' })
    const persisted = await evaluateAndPersistHgbClose('tenant-a', 'actor-a', 2026, readyRequest())
    mocks.transaction.hgbCloseRun.findFirst.mockResolvedValue({ ...persisted, payload: mocks.transaction.hgbCloseRun.create.mock.calls.at(-1)![0].data.payload })
    await expect(requireCurrentReadyHgbClose(mocks.transaction as never, 'tenant-a', { id: 'fy-2026', year: 2026 })).resolves.toMatchObject({ status: 'READY_TO_LOCK' })
    mocks.prisma.documentRecord.findMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map(id => ({ id, payload: JSON.stringify({ changedEvidence: id }) })))
    await expect(requireCurrentReadyHgbClose(mocks.transaction as never, 'tenant-a', { id: 'fy-2026', year: 2026 })).rejects.toThrow(/stale/)
  })

  it('retries a concurrent version reservation conflict without losing the immutable evaluation', async () => {
    mocks.prisma.compliancePackage.findFirst.mockResolvedValue({ id: 'annual-1', status: 'APPROVED' })
    mocks.prisma.$transaction.mockRejectedValueOnce({ code: 'P2002' })
    const result = await evaluateAndPersistHgbClose('tenant-a', 'actor-a', 2026, readyRequest())
    expect(result.status).toBe('READY_TO_LOCK')
    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(2)
  })
})
