import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import type { HgbCloseProfile } from '@/core/hgbClose'
import type { HgbWorkpaperDraft } from '@/core/hgbWorkpapers'
import type { HgbReviewPolicyChoice } from '@/core/hgbReviewPolicy'

vi.mock('server-only', () => ({}))
const directory = mkdtempSync(join(tmpdir(), 'hgb-owner-review-'))
const databasePath = join(directory, 'test.db').replaceAll('\\', '/')
let prisma: typeof import('@/server/persistence/client').prisma
let policyApi: typeof import('./hgbReviewPolicyRepository')
let workpaperApi: typeof import('./hgbWorkpaperRepository')

const profile: HgbCloseProfile = { ruleSetVersion: 'HGB-DE-2024.1', legalForm: 'UG', fiscalPeriodStart: '2026-01-01', fiscalPeriodEnd: '2026-12-31', germanRegisteredEntity: true, groupStatus: 'STANDALONE_NO_EXEMPTION', publicInterestEntity: false, capitalMarketOrListed: false, regulatedIndustry: false, liquidationOrInsolvencyBasis: false, goingConcern: true, formedOrConvertedInCurrentPeriod: false, currentSizeFacts: { balanceSheetTotalCents: 101900, revenueCents: 11900, quarterlyEmployeeCounts: [0, 0, 0, 0], microExcludedBySection267a: false }, priorSizeFacts: { balanceSheetTotalCents: 90000, revenueCents: 0, quarterlyEmployeeCounts: [0, 0, 0, 0], microExcludedBySection267a: false }, priorEstablishedSize: 'MICRO', hasInventory: false, hasFixedAssets: false, section5aApplies: true }

beforeAll(async () => {
  const db = new DatabaseSync(databasePath)
  const migrations = resolve('prisma/migrations')
  for (const name of readdirSync(migrations, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort()) db.exec(readFileSync(join(migrations, name, 'migration.sql'), 'utf8'))
  db.close()
  process.env.DATABASE_URL = `file:${databasePath}`
  process.env.AUDIT_INTEGRITY_SECRET = 'hgb-policy-test-only-audit-material-32-characters'
  prisma = (await import('@/server/persistence/client')).prisma
  policyApi = await import('./hgbReviewPolicyRepository')
  workpaperApi = await import('./hgbWorkpaperRepository')
})
afterAll(async () => {
  await prisma?.$disconnect()
  if (!resolve(directory).startsWith(resolve(tmpdir()) + '\\') && !resolve(directory).startsWith(resolve(tmpdir()) + '/')) throw new Error('Unexpected cleanup path')
  rmSync(directory, { recursive: true, force: true })
})

async function setup(legalForm = 'UG') {
  const ownerId = randomUUID(); const evidenceId = randomUUID()
  const period = await prisma.fiscalYear.create({ data: { ownerId, year: 2026, startsAt: new Date('2026-01-01'), endsAt: new Date('2026-12-31') } })
  await prisma.companyProfileVersion.create({ data: { ownerId, createdBy: ownerId, reason: 'Synthetic fixture', effectiveFrom: new Date('2026-01-01'), payload: JSON.stringify({ legalForm, registeredAddress: { country: 'DE' }, chart: 'CUSTOM:UG' }) } })
  await prisma.documentRecord.create({ data: { id: evidenceId, ownerId, payload: JSON.stringify({ synthetic: true, title: 'Register, articles and size facts' }) } })
  const draft: HgbWorkpaperDraft = { kind: 'SIZE_AND_APPLICABILITY', title: '2026 scope', conclusion: 'COMPLETE', evidenceIds: [evidenceId], adjustments: [], schedule: { type: 'SIZE_APPLICABILITY', applicability: 'APPLICABLE', rationale: 'Verified synthetic size and scope', legalForm: 'UG', establishedSize: 'MICRO', currentFactsEvidenceId: evidenceId, priorFactsEvidenceId: evidenceId, standaloneNoExemption: true, nonPieUnlistedUnregulated: true, closeProfile: profile } }
  const saved = await workpaperApi.saveHgbWorkpaper(ownerId, ownerId, 2026, draft)
  await workpaperApi.prepareHgbWorkpaper(ownerId, ownerId, saved.id, saved.checksum)
  const choice: HgbReviewPolicyChoice = { mode: 'OWNER_SELF_REVIEW', reason: 'Sole shareholder/managing director verified against register and articles.', evidenceIds: [evidenceId], soleShareholderManagingDirector: true, noAdditionalReviewRequirement: true }
  return { ownerId, evidenceId, period, saved, draft, choice }
}

describe('durable HGB owner-selected policy', () => {
  test('Given an already posted adjustment, when a new policy requires a fresh review, then the revised workpaper reuses the original journal entry', async () => {
    const f = await setup()
    const policy = await policyApi.selectHgbReviewPolicy(f.ownerId, f.ownerId, 2026, f.choice, null)
    const expense = await prisma.ledgerAccount.create({ data: { ownerId: f.ownerId, number: 4900, name: 'Synthetic expense', category: 'EXPENSE' } })
    const liability = await prisma.ledgerAccount.create({ data: { ownerId: f.ownerId, number: 1700, name: 'Synthetic liability', category: 'LIABILITY' } })
    const draft: HgbWorkpaperDraft = {
      kind: 'CUT_OFF_AND_ACCRUAL_DEFERRAL', title: 'Synthetic accrual', conclusion: 'COMPLETE', evidenceIds: [f.evidenceId],
      adjustments: [{ id: 'accrual', bookingDate: '2026-12-31', description: 'Synthetic accrual', evidenceIds: [f.evidenceId], lines: [{ accountId: expense.id, debitCents: 100, creditCents: 0 }, { accountId: liability.id, debitCents: 0, creditCents: 100 }] }],
      schedule: { type: 'CUT_OFF_ACCRUAL_DEFERRAL', applicability: 'APPLICABLE', rationale: 'Synthetic sample', testedBeforeThrough: '2026-12-31', testedAfterThrough: '2027-01-31', populationEvidenceId: f.evidenceId, exceptionsResolved: true, items: [{ id: 'a', category: 'ACCRUED_EXPENSE', serviceFrom: '2026-01-01', serviceThrough: '2026-12-31', amountCents: 100, calculationEvidenceId: f.evidenceId, proposalId: 'accrual' }] },
    }
    const first = await workpaperApi.saveHgbWorkpaper(f.ownerId, f.ownerId, 2026, draft)
    await workpaperApi.prepareHgbWorkpaper(f.ownerId, f.ownerId, first.id, first.checksum)
    await workpaperApi.reviewHgbWorkpaper(f.ownerId, f.ownerId, first.id, 'APPROVE', 'Owner checked accrual', 2026, first.checksum, policy.id)
    const original = await prisma.hgbAdjustmentRecord.findFirstOrThrow({ where: { workpaperId: first.id } })
    const entry = await prisma.journalEntry.create({ data: { ownerId: f.ownerId, fiscalYearId: f.period.id, sequenceNumber: 1, bookingDate: new Date('2026-12-31'), documentNumber: 'SYNTHETIC-1', description: 'Synthetic posted accrual', lines: { create: [{ accountId: expense.id, debitCents: 100 }, { accountId: liability.id, creditCents: 100 }] } } })
    await prisma.hgbAdjustmentRecord.update({ where: { id: original.id }, data: { status: 'POSTED', postedEntryId: entry.id, postedBy: f.ownerId, postedAt: new Date() } })
    const nextPolicy = await policyApi.selectHgbReviewPolicy(f.ownerId, f.ownerId, 2026, { ...f.choice, reason: 'Renewed owner assessment' }, policy.id)
    const revised = await workpaperApi.saveHgbWorkpaper(f.ownerId, f.ownerId, 2026, draft)
    await workpaperApi.prepareHgbWorkpaper(f.ownerId, f.ownerId, revised.id, revised.checksum)
    await workpaperApi.reviewHgbWorkpaper(f.ownerId, f.ownerId, revised.id, 'APPROVE', 'Owner rechecked accrual', 2026, revised.checksum, nextPolicy.id)
    expect(await workpaperApi.postHgbAdjustment(f.ownerId, f.ownerId, 2026, revised.id, 'accrual', 'new-request')).toMatchObject({ status: 'POSTED', postedEntryId: entry.id, fingerprint: original.fingerprint })
    expect(await prisma.hgbAdjustmentRecord.count({ where: { ownerId: f.ownerId, fingerprint: original.fingerprint } })).toBe(2)
    expect(await prisma.journalEntry.count({ where: { ownerId: f.ownerId } })).toBe(1)
  })
  test('Given default independent control, when the owner explicitly selects self-review, then real identities, date, reason, policy and evidence are durably audited', async () => {
    const f = await setup()
    await expect(workpaperApi.reviewHgbWorkpaper(f.ownerId, f.ownerId, f.saved.id, 'APPROVE', 'Review')).rejects.toThrow(/distinct/)
    const policy = await policyApi.selectHgbReviewPolicy(f.ownerId, f.ownerId, 2026, f.choice, null)
    await workpaperApi.reviewHgbWorkpaper(f.ownerId, f.ownerId, f.saved.id, 'APPROVE', 'I rechecked the evidence as sole owner.', 2026, f.saved.checksum, policy.id)
    const reviewed = await prisma.hgbWorkpaperRecord.findUniqueOrThrow({ where: { id: f.saved.id } })
    expect(reviewed).toMatchObject({ status: 'REVIEWED', preparedBy: f.ownerId, reviewedBy: f.ownerId, reviewMode: 'OWNER_SELF_REVIEW', reviewPolicyId: policy.id, reviewReason: 'I rechecked the evidence as sole owner.', reviewEvidenceChecksum: expect.stringMatching(/^[a-f0-9]{64}$/), reviewedAt: expect.any(Date) })
    expect(await prisma.auditEvent.count({ where: { ownerId: f.ownerId, action: 'HGB_REVIEW_POLICY_SELECTED' } })).toBe(1)
    expect((await policyApi.loadHgbReviewPolicy(prisma, f.ownerId, f.period)).valid).toBe(true)
    await expect(prisma.hgbReviewPolicyRecord.update({ where: { id: policy.id }, data: { selectedBy: 'forged' } })).rejects.toThrow()
    await expect(prisma.hgbReviewPolicyRecord.delete({ where: { id: policy.id } })).rejects.toThrow()
    expect(await prisma.hgbReviewPolicyRecord.findUnique({ where: { id: policy.id } })).toMatchObject({ selectedBy: f.ownerId, checksum: policy.checksum })
    // Unchanged content must support a new version when its review policy changes.
    const revised = await workpaperApi.saveHgbWorkpaper(f.ownerId, f.ownerId, 2026, f.draft)
    expect(revised).toMatchObject({ version: 2, supersedesId: f.saved.id, checksum: f.saved.checksum })
    expect((await policyApi.loadHgbReviewPolicy(prisma, f.ownerId, f.period)).valid).toBe(false)
  })

  test('Given a delegate, foreign evidence, ineligible GmbH or stale policy selection, when choosing self-review, then no unauthorized policy is persisted', async () => {
    const f = await setup()
    await expect(policyApi.selectHgbReviewPolicy(f.ownerId, 'delegate', 2026, f.choice, null)).rejects.toThrow(/owner/)
    await expect(policyApi.selectHgbReviewPolicy(f.ownerId, f.ownerId, 2026, { ...f.choice, evidenceIds: ['foreign'] }, null)).rejects.toThrow(/evidence/)
    const gmbh = await setup('GMBH')
    await expect(policyApi.selectHgbReviewPolicy(gmbh.ownerId, gmbh.ownerId, 2026, gmbh.choice, null)).rejects.toThrow(/UG scope/)
    await expect(policyApi.selectHgbReviewPolicy(f.ownerId, f.ownerId, 2026, f.choice, 'stale')).rejects.toThrow(/changed/)
    expect(await prisma.hgbReviewPolicyRecord.count({ where: { ownerId: { in: [f.ownerId, gmbh.ownerId] } } })).toBe(0)
  })

  test('Given changed policy evidence or eligibility, when reviewing, then stale authority cannot authorize a review', async () => {
    const f = await setup(); const policy = await policyApi.selectHgbReviewPolicy(f.ownerId, f.ownerId, 2026, f.choice, null)
    await prisma.documentRecord.update({ where: { id: f.evidenceId }, data: { payload: '{"changed":true}' } })
    expect((await policyApi.loadHgbReviewPolicy(prisma, f.ownerId, f.period)).valid).toBe(false)
    await expect(workpaperApi.reviewHgbWorkpaper(f.ownerId, f.ownerId, f.saved.id, 'APPROVE', 'Self review', 2026, f.saved.checksum, policy.id)).rejects.toThrow(/stale/)
  })

  test('Given an open policy, when a request uses another year, stale checksum or locked period, then review and policy writes remain blocked', async () => {
    const f = await setup(); const policy = await policyApi.selectHgbReviewPolicy(f.ownerId, f.ownerId, 2026, f.choice, null)
    await expect(workpaperApi.reviewHgbWorkpaper(f.ownerId, f.ownerId, f.saved.id, 'APPROVE', 'Self review', 2025, f.saved.checksum, policy.id)).rejects.toThrow(/year/)
    await expect(workpaperApi.reviewHgbWorkpaper(f.ownerId, f.ownerId, f.saved.id, 'APPROVE', 'Self review', 2026, 'stale', policy.id)).rejects.toThrow(/checksum/)
    await expect(workpaperApi.reviewHgbWorkpaper('another-tenant', f.ownerId, f.saved.id, 'APPROVE', 'Self review')).rejects.toThrow(/not found/)
    await prisma.fiscalYear.update({ where: { id: f.period.id }, data: { status: 'LOCKED' } })
    await expect(workpaperApi.reviewHgbWorkpaper(f.ownerId, f.ownerId, f.saved.id, 'APPROVE', 'Self review')).rejects.toThrow(/not open/)
    await expect(policyApi.selectHgbReviewPolicy(f.ownerId, f.ownerId, 2026, f.choice, policy.id)).rejects.toThrow(/open fiscal/)
  })
})
