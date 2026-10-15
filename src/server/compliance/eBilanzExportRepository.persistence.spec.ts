import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { eBilanz2026Fixture } from '@/core/fixtures/eBilanz2026'
import { eBalanceChecksum } from '@/core/eBilanzExport'

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
let storage: ReturnType<typeof import('@/server/storage').getDocumentStorage>
const evidenceKey = (id: string) => `documents/${fixture.ownerId}/${id}.txt`
const evidenceBytes = (id: string) => Buffer.from(`Synthetic retained evidence: ${id}`)
const evidencePayload = (id: string) => JSON.stringify({ synthetic: true, id, storageKey: evidenceKey(id) })

beforeAll(async () => {
  const database = new DatabaseSync(databasePath)
  const migrations = resolve('prisma/migrations')
  for (const name of readdirSync(migrations, { withFileTypes: true }).filter(row => row.isDirectory()).map(row => row.name).sort()) database.exec(readFileSync(join(migrations, name, 'migration.sql'), 'utf8'))
  database.close()
  vi.stubEnv('DATABASE_URL', `file:${databasePath}`)
  vi.stubEnv('DOCUMENT_STORAGE_DRIVER', 'fs')
  vi.stubEnv('DOCUMENT_STORAGE_ROOT', join(directory, 'objects'))
  api = await import('./eBilanzExportRepository')
  prisma = (await import('@/server/persistence/client')).prisma
  storage = (await import('@/server/storage')).getDocumentStorage()
  await prisma.fiscalYear.create({ data: { id: fixture.fiscalYear.id, ownerId: fixture.ownerId, year: 2026, startsAt: new Date(fixture.fiscalYear.startsAt), endsAt: new Date(`${fixture.fiscalYear.endsAt}T23:59:59.999Z`), status: 'CLOSED', lockedAt: generation.lockedAt, closingSnapshot: snapshot } })
  await prisma.companyProfileVersion.create({ data: { id: 'profile-1', ownerId: fixture.ownerId, effectiveFrom: new Date('2025-01-01'), createdBy: 'owner', reason: 'Synthetic test profile', payload: JSON.stringify({
    companyName: fixture.company.companyName, legalForm: 'UG', taxNumber: fixture.company.taxNumber, taxOffice: 'Berlin',
    registeredAddress: { streetAndHouseNumber: 'Musterstraße 1', zipCode: '10115', city: 'Berlin', country: 'DE' },
    vatRegime: 'STANDARD', vatFilingFrequency: 'QUARTERLY', activity: 'Softwareentwicklung', sizeClass: 'MICRO', chart: 'SKR03', elections: [], registerCourt: 'Berlin', registerNumber: 'HRB 123',
  }) } })
  await prisma.fixedAssetRecord.create({ data: { id: 'laptop', ownerId: fixture.ownerId, createdBy: 'owner', payload: JSON.stringify({ id: 'laptop', tenantId: fixture.ownerId, description: 'Laptop', costCents: 120000, acquisitionDate: '2026-04-01', availableForUseDate: '2026-04-01', location: 'Berlin', usefulLifeMonths: 36, taxUsefulLifeMonths: 24, method: 'STRAIGHT_LINE', taxMethod: 'STRAIGHT_LINE', evidenceIds: ['evidence-tax-depreciation'] }) } })
  await prisma.assetEventRecord.create({ data: { id: 'depreciation-event', ownerId: fixture.ownerId, assetId: 'laptop', sequence: 1, postingId: 'synthetic-journal', approvedBy: 'owner', approvedAt: new Date('2027-03-31'), payload: JSON.stringify({ id: 'depreciation-event', assetId: 'laptop', sequence: 1, type: 'DEPRECIATION', effectiveDate: '2027-03-31', amountCents: 20000, bookAmountCents: 20000, taxAmountCents: 25000, approvedBy: 'owner', approvedAt: '2027-03-31T12:00:00.000Z', postingId: 'synthetic-journal', evidenceIds: ['evidence-tax-depreciation'] }) } })
  for (const id of fixture.reconciliation.evidenceIds) {
    const bytes = evidenceBytes(id)
    await storage.write(evidenceKey(id), bytes, { contentType: 'text/plain', fileName: `${id}.txt` })
    await prisma.documentRecord.create({ data: { id, ownerId: fixture.ownerId, payload: evidencePayload(id) } })
    await prisma.retainedArtifact.create({ data: { ownerId: fixture.ownerId, objectType: 'Document', objectId: id, version: 1, retentionClass: 'ACCOUNTING_RECORDS', storageKey: evidenceKey(id), contentHash: eBalanceChecksum(bytes), provenance: 'SYNTHETIC_TEST', periodEndsAt: new Date('2026-12-31'), retainUntil: new Date('2036-12-31') } })
  }
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2027-04-02T12:00:00.000Z'))
})

afterAll(async () => {
  vi.restoreAllMocks()
  await prisma?.$disconnect()
  vi.unstubAllEnvs()
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

  test.each(['substituted', 'missing'].flatMap(mutation => ['approval', 'export', 'publication'].map(boundary => ({ mutation, boundary }))))('Given $mutation retained evidence bytes, when $boundary is attempted, then retained evidence is required', async ({ mutation, boundary }) => {
    const id = fixture.reconciliation.evidenceIds[0]
    const prepared = await api.prepareAuthoritativeEBalanceExport(fixture.ownerId, fixture.fiscalYear.id, { asOf: '2027-04-02' })
    const before = await prisma.eBalanceReconciliationRecord.count()
    if (mutation === 'substituted') await storage.write(evidenceKey(id), Buffer.from('Substituted bytes'), { contentType: 'text/plain', fileName: `${id}.txt` })
    else await storage.delete(evidenceKey(id))
    try {
      if (boundary === 'approval') {
        const payload = structuredClone(fixture.reconciliation.payload)
        payload.nilReasons['company.businessId'] = `Distinct ${mutation} evidence regression.`
        await expect(api.recordTaxBalanceReconciliation(fixture.ownerId, 'owner', { fiscalYearId: fixture.fiscalYear.id, reason: 'Evidence fixity regression', payload, evidenceIds: fixture.reconciliation.evidenceIds }).then(() => undefined)).rejects.toThrow(/evidence/i)
      } else if (boundary === 'export') await expect(api.prepareAuthoritativeEBalanceExport(fixture.ownerId, fixture.fiscalYear.id).then(() => undefined)).rejects.toThrow(/evidence/i)
      else await expect(api.assertCurrentEBalanceExport(prisma, fixture.ownerId, prepared).then(() => undefined)).rejects.toThrow(/evidence/i)
      expect(await prisma.eBalanceReconciliationRecord.count()).toBe(before)
    } finally {
      await storage.write(evidenceKey(id), evidenceBytes(id), { contentType: 'text/plain', fileName: `${id}.txt` })
    }
  })

  test('Given document metadata without original retention, when reconciliation is approved, then metadata alone cannot authorize export', async () => {
    const id = 'unretained-evidence'
    await prisma.documentRecord.create({ data: { id, ownerId: fixture.ownerId, payload: evidencePayload(id) } })
    await storage.write(evidenceKey(id), evidenceBytes(id), { contentType: 'text/plain', fileName: `${id}.txt` })
    await expect(api.recordTaxBalanceReconciliation(fixture.ownerId, 'owner', { fiscalYearId: fixture.fiscalYear.id, reason: 'Unretained evidence regression', payload: fixture.reconciliation.payload, evidenceIds: [id] })).rejects.toThrow(/evidence/i)
  })

  test('given modified evidence or asset sources, refuses previously approved data', async () => {
    await prisma.documentRecord.update({ where: { id: 'evidence-tax-depreciation' }, data: { payload: JSON.stringify({ ...JSON.parse(evidencePayload('evidence-tax-depreciation')), changed: true }) } })
    await expect(api.prepareAuthoritativeEBalanceExport(fixture.ownerId, fixture.fiscalYear.id)).rejects.toThrow('evidence has changed')
    await prisma.documentRecord.update({ where: { id: 'evidence-tax-depreciation' }, data: { payload: evidencePayload('evidence-tax-depreciation') } })
    const row = await prisma.fixedAssetRecord.findUniqueOrThrow({ where: { id: 'laptop' } })
    await prisma.fixedAssetRecord.update({ where: { id: 'laptop' }, data: { payload: JSON.stringify({ ...JSON.parse(row.payload), description: 'Changed asset source' }) } })
    await expect(api.prepareAuthoritativeEBalanceExport(fixture.ownerId, fixture.fiscalYear.id)).rejects.toThrow('stale')
  })

  test('given foreign evidence or another tenant, rejects preparation and approval', async () => {
    await expect(api.prepareAuthoritativeEBalanceExport('foreign-tenant', fixture.fiscalYear.id)).rejects.toThrow('not found')
    await expect(api.recordTaxBalanceReconciliation(fixture.ownerId, 'owner', { fiscalYearId: fixture.fiscalYear.id, reason: 'Invalid proof', payload: fixture.reconciliation.payload, evidenceIds: ['missing-evidence'] })).rejects.toThrow('evidence is missing')
  })
})
