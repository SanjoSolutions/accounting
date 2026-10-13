import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Prisma } from '@/generated/prisma/client'
import { createHgbStatementRuleSet } from '@/core/hgbStatements'

const mocks = vi.hoisted(() => ({ evidence: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('./closeEvidence', async importOriginal => ({ ...await importOriginal<typeof import('./closeEvidence')>(), loadVerifiedCloseEvidence: mocks.evidence }))
vi.mock('@/core/hgbWorkpapers', () => ({ validateHgbWorkpaper: (value: unknown) => value, hgbWorkpaperChecksum: () => 'trusted-checksum' }))
import { assertCurrentAnnualPackage, loadAuthoritativeAnnualSource } from './annualReportingSource'

function fixture() {
  const profile = { id: 'profile-a', payload: JSON.stringify({ chart: 'CUSTOM:HGB', companyName: 'Synthetic UG', legalForm: 'UG', registerCourt: 'Berlin', registerNumber: 'HRB 1', registeredAddress: { city: 'Berlin' } }) }
  const rules = createHgbStatementRuleSet('MICRO', 'GKV')
  const leaves = rules.lines.filter(line => !rules.lines.some(child => child.parentId === line.id)).map(line => ({ lineId: line.id, amountCents: 0 }))
  const workpapers = [
    { kind: 'SIZE_AND_APPLICABILITY', schedule: { type: 'SIZE_APPLICABILITY', establishedSize: 'MICRO' } },
    { kind: 'POLICY_ELECTIONS', schedule: { type: 'POLICY_ELECTIONS', elections: [{ policy: 'TOTAL_COST_PNL', applicable: true, selected: true, rationale: 'Reviewed GKV election' }] } },
    { kind: 'OPENING_BALANCE', schedule: { type: 'OPENING_BALANCE', approvedComparativeLeaves: leaves } },
    ...['MAPPING_AND_PRESENTATION', 'RECOGNITION_AND_OWNERSHIP', 'CUT_OFF_AND_ACCRUAL_DEFERRAL', 'PROVISIONS_AND_CONTINGENCIES', 'RECEIVABLE_AND_MARKET_VALUATION'].map(kind => ({ kind, schedule: { type: kind } })),
  ].map((payload, index) => ({ id: `wp-${index}`, kind: payload.kind, version: 1, status: 'REVIEWED', checksum: 'trusted-checksum', payload: JSON.stringify(payload) }))
  const entries = [{ id: 'entry-a', state: 'POSTED', lines: [
    { id: 'line-bank', accountId: 'bank', debitCents: 100, creditCents: 0, account: { number: 1200 } },
    { id: 'line-revenue', accountId: 'revenue', debitCents: 0, creditCents: 100, account: { number: 8400 } },
  ] }]
  const current = { id: 'fy-2026', ownerId: 'tenant-a', year: 2026, startsAt: new Date('2026-01-01Z'), endsAt: new Date('2026-12-31Z'), status: 'OPEN', lockedAt: null as Date | null, journalEntries: entries }
  const previous = { id: 'fy-2025', year: 2025, startsAt: new Date('2025-01-01Z'), endsAt: new Date('2025-12-31Z'), journalEntries: [] }
  const mappings = [
    { id: 'map-bank', accountNumber: 1200, hgbPosition: 'BS.A.B', normalBalance: 'DEBIT', presentationSign: 1, effectiveFrom: new Date('2025-01-01Z'), effectiveTo: null },
    { id: 'map-revenue', accountNumber: 8400, hgbPosition: 'IS.M.1', normalBalance: 'CREDIT', presentationSign: 1, effectiveFrom: new Date('2025-01-01Z'), effectiveTo: null },
  ]
  const adjustments: Array<{ id: string; status: string }> = []
  const client = {
    companyProfileVersion: { findFirst: vi.fn(async () => profile) },
    fiscalYear: { findFirst: vi.fn(async ({ where }: { where: { endsAt?: unknown } }) => where.endsAt ? previous : current) },
    accountMappingVersion: { findMany: vi.fn(async () => mappings) },
    hgbWorkpaperRecord: { findMany: vi.fn(async () => workpapers) },
    hgbAdjustmentRecord: { findMany: vi.fn(async () => adjustments) },
  } as unknown as Prisma.TransactionClient
  const load = () => loadAuthoritativeAnnualSource(client, 'tenant-a', 'preparer', current)
  return { client, profile, current, previous, workpapers, mappings, adjustments, load }
}

describe('annual package source revision binding', () => {
  beforeEach(() => mocks.evidence.mockResolvedValue({ evidence: [{ id: 'doc', source: 'DOCUMENT', contentHash: 'original-hash' }], missingEvidenceIds: [] }))

  test.each(['ledger', 'comparative-period', 'profile', 'mapping', 'workpaper-revision', 'adjustment', 'evidence'] as const)('Given an approved package and changed %s, when current-source authority is checked, then the old package is rejected', async field => {
    const f = fixture()
    const { sourceFingerprint } = await f.load()
    const record = { ownerId: 'tenant-a', fiscalPeriodId: f.current.id, createdBy: 'preparer', version: 1, supersedesId: null, payload: JSON.stringify({ version: 1, sourceFingerprint }) }
    await expect(assertCurrentAnnualPackage(f.client, record)).resolves.toBeUndefined()
    if (field === 'ledger') { f.current.journalEntries[0].lines[0].debitCents++; f.current.journalEntries[0].lines[1].creditCents++ }
    if (field === 'comparative-period') f.previous.id = 'different-comparative-year'
    if (field === 'profile') f.profile.id = 'profile-next'
    if (field === 'mapping') f.mappings[0].id = 'replacement-mapping'
    if (field === 'workpaper-revision') f.workpapers[0].version++
    if (field === 'adjustment') f.adjustments.push({ id: 'posted-adjustment', status: 'POSTED' })
    if (field === 'evidence') mocks.evidence.mockResolvedValue({ evidence: [{ id: 'doc', source: 'DOCUMENT', contentHash: 'changed-hash' }], missingEvidenceIds: [] })
    await expect(assertCurrentAnnualPackage(f.client, record)).rejects.toThrow(/sources changed/)
  })

  test('Given the same annual sources, when row order or fiscal lock metadata changes, then its source binding remains stable', async () => {
    const f = fixture()
    const first = await f.load()
    f.current.status = 'CLOSED'; f.current.lockedAt = new Date('2027-01-01Z')
    f.mappings.reverse(); f.workpapers.reverse(); f.current.journalEntries[0].lines.reverse()
    expect((await f.load()).sourceFingerprint).toBe(first.sourceFingerprint)
  })

  test.each([{ version: 2, sourceFingerprint: 'hash' }, { version: 1 }, { version: 1, sourceFingerprint: 'hash', supersedesId: 'other' }])('Given an unbound or mismatched package version %j, when authority is checked, then regeneration is required', async envelope => {
    const f = fixture()
    await expect(assertCurrentAnnualPackage(f.client, { ownerId: 'tenant-a', fiscalPeriodId: f.current.id, createdBy: 'preparer', version: 1, supersedesId: null, payload: JSON.stringify(envelope) })).rejects.toThrow(/source and version binding/)
  })
})
