import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { eBilanz2026Fixture } from '@/core/fixtures/eBilanz2026'
import { eBalanceChecksum } from '@/core/eBilanzExport'
import { E_BALANCE_ATTACHMENT_KINDS } from '@/core/eBilanzReportScope'

vi.mock('server-only', () => ({}))
vi.mock('@/server/fiscalCloseGeneration', () => ({ requireCurrentFiscalCloseGeneration: vi.fn(async () => generation) }))
vi.mock('./auditPersistence', () => ({ appendAuditEvent: vi.fn(async () => undefined) }))
const fixture = eBilanz2026Fixture()
const snapshot = JSON.stringify({ balances: fixture.balances })
const generation = { ...fixture.closeGeneration, snapshotHash: eBalanceChecksum(snapshot), lockedAt: new Date(fixture.closeGeneration.lockedAt), hgbCloseRunId: 'hgb-1' }
const directory = mkdtempSync(join(tmpdir(), 'accounting-issue36-test-'))
const databasePath = join(directory, 'export-test.db').replace(/\\/g, '/')
let api: typeof import('./eBilanzExportRepository')
let prisma: typeof import('@/server/persistence/client').prisma

beforeAll(async () => {
  const database = new DatabaseSync(databasePath)
  const migrations = resolve('prisma/migrations')
  for (const name of readdirSync(migrations, { withFileTypes: true }).filter(row => row.isDirectory()).map(row => row.name).sort()) database.exec(readFileSync(join(migrations, name, 'migration.sql'), 'utf8'))
  database.close()
  process.env.DATABASE_URL = `file:${databasePath}`
  api = await import('./eBilanzExportRepository')
  prisma = (await import('@/server/persistence/client')).prisma
  await prisma.fiscalYear.create({ data: { id: fixture.fiscalYear.id, ownerId: fixture.ownerId, year: 2026, startsAt: new Date(fixture.fiscalYear.startsAt), endsAt: new Date(`${fixture.fiscalYear.endsAt}T23:59:59.999Z`), status: 'CLOSED', lockedAt: generation.lockedAt, closingSnapshot: snapshot } })
  await prisma.companyProfileVersion.create({ data: { id: 'profile-1', ownerId: fixture.ownerId, effectiveFrom: new Date('2025-01-01'), createdBy: 'owner', reason: 'Synthetic test profile', payload: JSON.stringify({
    companyName: fixture.company.companyName, legalForm: 'UG', taxNumber: fixture.company.taxNumber, taxOffice: 'Berlin',
    registeredAddress: { streetAndHouseNumber: 'Musterstraße 1', zipCode: '10115', city: 'Berlin', country: 'DE' },
    vatRegime: 'STANDARD', vatFilingFrequency: 'QUARTERLY', activity: 'Softwareentwicklung', sizeClass: 'MICRO', chart: 'SKR03', elections: [], registerCourt: 'Berlin', registerNumber: 'HRB 123',
  }) } })
  await prisma.fixedAssetRecord.create({ data: { id: 'laptop', ownerId: fixture.ownerId, createdBy: 'owner', payload: JSON.stringify({ id: 'laptop', tenantId: fixture.ownerId, description: 'Laptop', costCents: 120000, acquisitionDate: '2026-04-01', availableForUseDate: '2026-04-01', location: 'Berlin', usefulLifeMonths: 36, taxUsefulLifeMonths: 24, method: 'STRAIGHT_LINE', taxMethod: 'STRAIGHT_LINE', evidenceIds: ['evidence-tax-depreciation'] }) } })
  await prisma.assetEventRecord.create({ data: { id: 'depreciation-event', ownerId: fixture.ownerId, assetId: 'laptop', sequence: 1, postingId: 'synthetic-journal', approvedBy: 'owner', approvedAt: new Date('2027-03-31'), payload: JSON.stringify({ id: 'depreciation-event', assetId: 'laptop', sequence: 1, type: 'DEPRECIATION', effectiveDate: '2027-03-31', amountCents: 20000, bookAmountCents: 20000, taxAmountCents: 25000, approvedBy: 'owner', approvedAt: '2027-03-31T12:00:00.000Z', postingId: 'synthetic-journal', evidenceIds: ['evidence-tax-depreciation'] }) } })
  for (const id of fixture.reconciliation.evidenceIds) await prisma.documentRecord.create({ data: { id, ownerId: fixture.ownerId, payload: JSON.stringify({ synthetic: true, id }) } })
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2027-04-02T12:00:00.000Z'))
})

afterAll(async () => {
  vi.restoreAllMocks()
  await prisma?.$disconnect()
  delete process.env.DATABASE_URL
  rmSync(directory, { recursive: true, force: true })
})

const approval = () => api.recordTaxBalanceReconciliation(fixture.ownerId, 'owner', {
  fiscalYearId: fixture.fiscalYear.id, reason: 'Approve documented complete tax balance', payload: fixture.reconciliation.payload, evidenceIds: fixture.reconciliation.evidenceIds,
})

describe('persisted authoritative E-Bilanz snapshots', () => {
  test('given missing approval, refuses export even with a locked close', async () => {
    await expect(api.prepareAuthoritativeEBalanceExport(fixture.ownerId, fixture.fiscalYear.id)).rejects.toThrow('approved complete')
  })

  test('given approved evidence, exports official XML without ERiC configuration and retains corrected approval history', async () => {
    const first = await approval()
    const prepared = await api.prepareAuthoritativeEBalanceExport(fixture.ownerId, fixture.fiscalYear.id, { asOf: '2027-04-02' })
    expect(prepared.dataset.totals.taxNetIncomeCents).toBe(50000)
    expect(prepared.dataset.accounts.find(account => account.accountId === 'bank-inactive')?.amountCents).toBe(55000)
    expect(prepared.reportChecksum).toBe(eBalanceChecksum(prepared.xml))
    expect(JSON.parse(api.serializePreparedEBalanceEvidence(prepared))).toMatchObject({ format: 'OFFICIAL_XBRL', dataset: { closeGenerationId: generation.id } })
    await expect(api.assertCurrentEBalanceExport(prisma, fixture.ownerId, prepared)).resolves.toMatchObject({ id: generation.id })
    const report = { reportPayload: api.serializePreparedEBalanceEvidence(prepared), reportXml: prepared.xml, reportChecksum: prepared.reportChecksum, closeGenerationId: generation.id }
    await expect(api.assertCurrentEBalanceReport(prisma, fixture.ownerId, report)).resolves.toBeUndefined()
    await expect(api.assertCurrentEBalanceReport(prisma, fixture.ownerId, { ...report, reportXml: '<internal/>' })).rejects.toThrow('verified official')
    const corrected = structuredClone(fixture.reconciliation.payload)
    corrected.nilReasons['company.businessId'] = 'Corrected documentation: assignment still pending.'
    const second = await api.recordTaxBalanceReconciliation(fixture.ownerId, 'owner', { fiscalYearId: fixture.fiscalYear.id, reason: 'Correct nil explanation', payload: corrected, evidenceIds: fixture.reconciliation.evidenceIds })
    expect(second.id).not.toBe(first.id)
    await expect(api.assertCurrentEBalanceExport(prisma, fixture.ownerId, prepared)).rejects.toThrow('changed')
    await expect(api.assertCurrentEBalanceReport(prisma, fixture.ownerId, report)).rejects.toThrow('changed')
    expect((await prisma.eBalanceReconciliationRecord.findUniqueOrThrow({ where: { id: first.id } })).payload).toBe(first.payload)
  }, 15000)

  test('given a V2 revision, checks its predecessor and retains attachment evidence through the real preparation path', async () => {
    const first = await api.prepareAuthoritativeEBalanceExport(fixture.ownerId, fixture.fiscalYear.id)
    await prisma.eBalanceLifecycleReport.create({ data: { id: 'report-before-revision', ownerId: fixture.ownerId, fiscalYearId: fixture.fiscalYear.id, version: 1,
      status: 'ACCEPTED', taxonomyVersion: '6.9', profileSnapshot: '{}', reportPayload: api.serializePreparedEBalanceEvidence(first), reportXml: first.xml,
      reportChecksum: first.reportChecksum, storageKey: 'synthetic-previous-report', createdBy: 'owner' } })
    await prisma.documentRecord.create({ data: { id: 'attachment-evidence', ownerId: fixture.ownerId, payload: '{"text":"Synthetic notes"}' } })
    const payload = structuredClone(fixture.reconciliation.payload)
    payload.schemaVersion = 'EBILANZ_TAX_BALANCE_V2'
    payload.adjustments[0].classification = { kind: 'TEMPORARY', reversalExpectedThrough: '2030-03-31' }
    payload.revision = { status: 'B', reason: 'Corrected synthetic notes', supersedes: { reportId: 'report-before-revision', reportChecksum: first.reportChecksum } }
    payload.attachments = E_BALANCE_ATTACHMENT_KINDS.map(kind => kind === 'NOTES'
      ? { kind, status: 'PRESENT', text: 'Synthetic notes', evidenceIds: ['attachment-evidence'] }
      : { kind, status: 'NOT_APPLICABLE', reason: 'Not applicable to this fixture.' })
    const record = () => api.recordTaxBalanceReconciliation(fixture.ownerId, 'owner', { fiscalYearId: fixture.fiscalYear.id, reason: 'Approve scoped revision', payload, evidenceIds: fixture.reconciliation.evidenceIds })
    const predecessor = await prisma.eBalanceLifecycleReport.findUniqueOrThrow({ where: { id: 'report-before-revision' } })
    for (const scope of [{ id: 'foreign-predecessor', ownerId: 'foreign-owner' }, { id: 'wrong-period-predecessor', fiscalYearId: 'different-period' }]) {
      await prisma.eBalanceLifecycleReport.create({ data: { ...predecessor, ...scope } })
      payload.revision.supersedes!.reportId = scope.id
      await expect(record()).rejects.toThrow('predecessor')
    }
    payload.revision.supersedes!.reportId = 'report-before-revision'
    payload.revision.supersedes!.reportChecksum = '0'.repeat(64)
    await expect(record()).rejects.toThrow('predecessor')
    payload.revision.supersedes!.reportChecksum = first.reportChecksum
    await record()
    const prepared = await api.prepareAuthoritativeEBalanceExport(fixture.ownerId, fixture.fiscalYear.id)
    expect(prepared.xml).toContain('revisionStatus.B contextRef')
    expect(prepared.xml).toContain('Synthetic notes')
    expect(prepared.xml).toContain('reportElements.AV')
    await expect(api.assertCurrentEBalanceExport(prisma, fixture.ownerId, prepared)).resolves.toMatchObject({ id: generation.id })
    const upgraded = await api.prepareAuthoritativeEBalanceExport(fixture.ownerId, fixture.fiscalYear.id, { taxonomyVersion: '6.10', taxonomyPreparation: 'LOCAL' })
    expect(upgraded.dataset.taxonomy.version).toBe('6.10')
    expect(upgraded.diagnostics.officialAcceptance).toBe('NOT_VALIDATED')
    await prisma.documentRecord.update({ where: { id: 'attachment-evidence' }, data: { payload: '{"text":"Changed notes"}' } })
    await expect(api.assertCurrentEBalanceExport(prisma, fixture.ownerId, prepared)).rejects.toThrow('evidence changed')
    expect((await prisma.eBalanceLifecycleReport.findUniqueOrThrow({ where: { id: 'report-before-revision' } })).reportXml).toBe(first.xml)
    // Restore the evidence for the independent source-tampering cases below.
    await prisma.documentRecord.update({ where: { id: 'attachment-evidence' }, data: { payload: '{"text":"Synthetic notes"}' } })
  }, 60000)

  test('given modified evidence or asset sources, refuses previously approved data', async () => {
    await prisma.documentRecord.update({ where: { id: 'evidence-tax-depreciation' }, data: { payload: '{"changed":true}' } })
    await expect(api.prepareAuthoritativeEBalanceExport(fixture.ownerId, fixture.fiscalYear.id)).rejects.toThrow('evidence has changed')
    await prisma.documentRecord.update({ where: { id: 'evidence-tax-depreciation' }, data: { payload: JSON.stringify({ synthetic: true, id: 'evidence-tax-depreciation' }) } })
    const row = await prisma.fixedAssetRecord.findUniqueOrThrow({ where: { id: 'laptop' } })
    await prisma.fixedAssetRecord.update({ where: { id: 'laptop' }, data: { payload: JSON.stringify({ ...JSON.parse(row.payload), description: 'Changed asset source' }) } })
    await expect(api.prepareAuthoritativeEBalanceExport(fixture.ownerId, fixture.fiscalYear.id)).rejects.toThrow('stale')
  })

  test('given foreign evidence or another tenant, rejects preparation and approval', async () => {
    await expect(api.prepareAuthoritativeEBalanceExport('foreign-tenant', fixture.fiscalYear.id)).rejects.toThrow('not found')
    await expect(api.recordTaxBalanceReconciliation(fixture.ownerId, 'owner', { fiscalYearId: fixture.fiscalYear.id, reason: 'Invalid proof', payload: fixture.reconciliation.payload, evidenceIds: ['missing-evidence'] })).rejects.toThrow('evidence is missing')
  })
})
