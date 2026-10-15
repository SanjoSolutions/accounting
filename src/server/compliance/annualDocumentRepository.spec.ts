import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, afterAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { unzipSync, strFromU8 } from 'fflate'
import { annualDocumentFixture } from '@/test/annualDocumentFixture'
import { canonicalJson } from '@/core/compliance/auditExport'
import { hashDocument } from '@/core/compliance/annualDocuments'
import { prepareAnnualAccounts } from '@/core/compliance/annualAccounts'

vi.mock('server-only', () => ({}))
const mocks = vi.hoisted(() => ({ current: vi.fn() }))
vi.mock('@/server/hgbCloseRepository', () => ({ requireCurrentReadyHgbClose: mocks.current }))
const directory = mkdtempSync(join(tmpdir(), 'annual-documents-test-'))
const databasePath = join(directory, 'test.db').replaceAll('\\', '/')
let api: typeof import('./annualDocumentRepository')
let prisma: typeof import('@/server/persistence/client').prisma
let storage: ReturnType<typeof import('@/server/storage').getDocumentStorage>
let source = annualDocumentFixture()
let sequence = 0
let sourceKey = ''

beforeAll(async () => {
  const database = new DatabaseSync(databasePath)
  const migrations = resolve('prisma/migrations')
  for (const name of readdirSync(migrations, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort()) database.exec(readFileSync(join(migrations, name, 'migration.sql'), 'utf8'))
  database.close()
  vi.stubEnv('DATABASE_URL', `file:${databasePath}`); vi.stubEnv('DOCUMENT_STORAGE_ROOT', join(directory, 'objects')); vi.stubEnv('AUDIT_INTEGRITY_SECRET', 'annual-documents-disposable-test-key-32')
  api = await import('./annualDocumentRepository'); prisma = (await import('@/server/persistence/client')).prisma; storage = (await import('@/server/storage')).getDocumentStorage()
})
afterAll(async () => { await prisma?.$disconnect(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }) })
beforeEach(async () => {
  sequence++; source = annualDocumentFixture(); source.packageId = `annual-${sequence}`
  const periodId = `period-${sequence}`
  // Distinct periods in each case avoid resetting any existing data.
  const year = 2026 + sequence
  source.input.fiscalYear = year; source.input.previousFiscalYear = year - 1
  source.input.fiscalPeriodStart = `${year}-01-01`; source.input.fiscalPeriodEnd = `${year}-12-31`
  source.input.previousFiscalPeriodStart = `${year - 1}-01-01`; source.input.previousFiscalPeriodEnd = `${year - 1}-12-31`
  source.input.preparedAt = `${year + 1}-03-01T10:00:00Z`; source.annual = prepareAnnualAccounts(source.input, 1)
  await prisma.fiscalYear.create({ data: { id: periodId, ownerId: 'tenant-a', year, startsAt: new Date(source.input.fiscalPeriodStart), endsAt: new Date(`${source.input.fiscalPeriodEnd}T23:59:59.999Z`) } })
  const payload = canonicalJson(source.annual)
  source.packageChecksum = hashDocument(canonicalJson({ kind: 'ANNUAL_ACCOUNTS', fiscalPeriodId: periodId, authorityRef: null, payload: source.annual }))
  sourceKey = `closing-snapshots/tenant-a/${source.packageId}.json`
  await storage.write(sourceKey, Buffer.from(payload), { contentType: 'application/json', fileName: 'annual.json' })
  await prisma.compliancePackage.create({ data: { id: source.packageId, ownerId: 'tenant-a', fiscalPeriodId: periodId, kind: 'ANNUAL_ACCOUNTS', status: 'APPROVED', version: 1, payload, checksum: source.packageChecksum, storageKey: sourceKey, createdBy: 'preparer', approvedBy: source.approvedBy, approvedAt: new Date(source.approvedAt) } })
  await prisma.retainedArtifact.create({ data: { ownerId: 'tenant-a', objectType: 'CompliancePackage', objectId: source.packageId, version: 1, retentionClass: 'ACCOUNTING_RECORDS', contentHash: hashDocument(payload), provenance: 'ANNUAL_ACCOUNTS', storageKey: sourceKey, periodEndsAt: new Date('2026-12-31'), retainUntil: new Date('2036-12-31') } })
  await prisma.hgbWorkpaperRecord.create({ data: { id: `equity-${sequence}`, ownerId: 'tenant-a', fiscalPeriodId: periodId, kind: 'GMBH_EQUITY_AND_RESULT', version: 1, status: 'REVIEWED', ruleSetVersion: 'HGB-DE-2024.1', checksum: `fixture-${sequence}`, payload: JSON.stringify({ schedule: { type: 'GMBH_EQUITY_RESULT', ...source.equity } }), createdBy: 'preparer', updatedBy: 'preparer' } })
  mocks.current.mockReset().mockResolvedValue({ id: source.close.id, checksum: source.close.checksum, payload: JSON.stringify({ input: { annualAccountsPackageId: source.packageId, annualAccountsChecksum: source.packageChecksum, managingDirectorSignatures: source.close.signatures, shareholderResolutionId: source.close.resolutionId }, readiness: { size: 'SMALL', notesRequired: true } }) })
})

describe('durable immutable annual document exports', () => {
  test('Given an approved exact version, when exported and downloaded, then ZIP bytes, manifest and audit events are retained without filing state changes', async () => {
    const artifact = await api.createAnnualDocumentBundle('tenant-a', 'actor-a', source.packageId, { mode: 'annual', expectedChecksum: source.packageChecksum })
    const first = await api.downloadAnnualDocument('tenant-a', 'reader-a', source.packageId, artifact.id, 'bundle')
    const files = unzipSync(first.content); const manifest = JSON.parse(strFromU8(files['manifest.json']))
    expect(manifest).toMatchObject({ sourcePackageId: source.packageId, sourceChecksum: source.packageChecksum, status: 'EXPORTED_NOT_FILED' })
    expect(manifest.files['jahresabschluss.html'].sha256).toBe(hashDocument(files['jahresabschluss.html']))
    expect(await prisma.auditEvent.count({ where: { objectId: artifact.id } })).toBe(2)
    expect((await prisma.compliancePackage.findUniqueOrThrow({ where: { id: source.packageId } })).status).toBe('APPROVED')
    mocks.current.mockRejectedValue(new Error('Current ledger is stale'))
    await prisma.compliancePackage.update({ where: { id: source.packageId }, data: { status: 'SUPERSEDED' } })
    const second = await api.downloadAnnualDocument('tenant-a', 'reader-a', source.packageId, artifact.id, 'bundle')
    expect(Buffer.from(second.content).equals(Buffer.from(first.content))).toBe(true)
    await expect(api.createAnnualDocumentBundle('tenant-a', 'actor-a', source.packageId, { mode: 'annual', expectedChecksum: source.packageChecksum })).rejects.toThrow(/stale/)
  })
  test('Given foreign tenants, unapproved sources or stale selection, when exporting, then access and current-close checks fail closed', async () => {
    await expect(api.createAnnualDocumentBundle('tenant-a', 'actor-a', source.packageId, { mode: ['annual'], expectedChecksum: source.packageChecksum })).rejects.toThrow(/Choose/)
    await expect(api.annualDocumentOptions('tenant-b', source.packageId)).rejects.toThrow(/not found/)
    await expect(api.createAnnualDocumentBundle('tenant-a', 'actor-a', source.packageId, { mode: 'annual', expectedChecksum: 'wrong' })).rejects.toThrow(/checksum/)
    mocks.current.mockResolvedValue({ id: 'new-close', checksum: 'new', payload: JSON.stringify({ input: { annualAccountsPackageId: 'other-version' }, readiness: { size: 'SMALL' } }) })
    await expect(api.createAnnualDocumentBundle('tenant-a', 'actor-a', source.packageId, { mode: 'annual', expectedChecksum: source.packageChecksum })).rejects.toThrow(/selected annual version/)
    await prisma.compliancePackage.update({ where: { id: source.packageId }, data: { status: 'CREATED' } })
    await expect(api.annualDocumentOptions('tenant-a', source.packageId)).rejects.toThrow(/not found/)
  })
  test('Given corrupt source or retained export bytes, when requested, then fixity prevents downloads and no successful audit is emitted', async () => {
    const artifact = await api.createAnnualDocumentBundle('tenant-a', 'actor-a', source.packageId, { mode: 'annual', expectedChecksum: source.packageChecksum })
    await expect(api.downloadAnnualDocument('tenant-b', 'reader-b', source.packageId, artifact.id, 'bundle')).rejects.toThrow(/not found/)
    await expect(api.downloadAnnualDocument('tenant-a', 'reader-a', source.packageId, artifact.id, '../private')).rejects.toThrow(/not found/)
    const retained = await prisma.retainedArtifact.findUniqueOrThrow({ where: { id: artifact.id } })
    await storage.write(retained.storageKey!, Buffer.from('corrupt'), { contentType: 'application/zip', fileName: 'bad.zip' })
    await expect(api.downloadAnnualDocument('tenant-a', 'reader-a', source.packageId, artifact.id, 'bundle')).rejects.toThrow(/fixity/)
    await storage.write(sourceKey, Buffer.from('{}'), { contentType: 'application/json', fileName: 'bad.json' })
    await expect(api.annualDocumentOptions('tenant-a', source.packageId)).rejects.toThrow(/fixity/)
    expect(await prisma.auditEvent.count({ where: { objectId: artifact.id, action: 'EXPORT_DOWNLOADED' } })).toBe(0)
  })
  test('Given reviewed manual selection, when retained, then the package excludes internal companions and immutable evidence details', async () => {
    const artifact = await api.createAnnualDocumentBundle('tenant-a', 'actor-a', source.packageId, { mode: 'manual', expectedChecksum: source.packageChecksum, selection: { noteIndexes: [0, 1], policyIndexes: [0], establishedOn: '2036-03-03', confirmedCompleteAndMinimized: true, ...{ privateMemo: 'DO NOT RETAIN THIS REQUEST FIELD' } } })
    const result = await api.downloadAnnualDocument('tenant-a', 'reader-a', source.packageId, artifact.id, 'bundle')
    const files = unzipSync(result.content)
    expect(Object.keys(files).sort()).toEqual(['ANLEITUNG.txt', 'einreichung.html', 'manifest.json'])
    const publicHtml = strFromU8(files['einreichung.html'])
    expect(publicHtml).not.toContain('PRIVATE'); expect(publicHtml).not.toContain('private-signature')
    expect(strFromU8(files['manifest.json'])).not.toContain('DO NOT RETAIN')
    await expect(api.downloadAnnualDocument('tenant-a', 'reader-a', source.packageId, artifact.id, 'abschluss.json')).rejects.toThrow(/not found/)
  })
  test('Given a close changed while its export is being written, when registration rechecks it, then the export is rejected and its new object is removed', async () => {
    const original = await mocks.current()
    mocks.current.mockResolvedValueOnce(original).mockResolvedValueOnce({ ...original, id: 'concurrent-close' })
    const removed = vi.spyOn(storage, 'delete')
    try {
      await expect(api.createAnnualDocumentBundle('tenant-a', 'actor-a', source.packageId, { mode: 'annual', expectedChecksum: source.packageChecksum })).rejects.toThrow(/close changed/)
      expect(removed).toHaveBeenCalledOnce()
      expect(await prisma.retainedArtifact.count({ where: { objectType: 'AnnualDocumentBundle', objectId: source.packageId } })).toBe(0)
      expect(await prisma.auditEvent.count({ where: { objectType: 'AnnualDocumentBundle', action: 'EXPORT_CREATED', ownerId: 'tenant-a', semanticDelta: { contains: source.packageId } } })).toBe(0)
    } finally { removed.mockRestore() }
  })
})
