import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { canonicalJson } from '@/core/compliance/auditExport'
import { createAuthoritativeEBalanceDataset, eBalanceChecksum } from '@/core/eBilanzExport'
import { eBilanz2026Fixture } from '@/core/fixtures/eBilanz2026'
import { OFFICIAL_E_BALANCE_TAXONOMIES } from '@/core/eBilanzTaxonomy'
import { readEBalanceTaxonomy } from '@/core/eBilanzTaxonomyModel'
import { serializeEBalanceFilingXml } from '@/core/eBilanzFilingXml'
import { verifyAuditChain } from './auditPersistence'

vi.mock('server-only', () => ({}))
const current = vi.hoisted(() => ({ export: vi.fn(), report: vi.fn() }))
vi.mock('./eBilanzExportRepository', async importOriginal => ({
  ...await importOriginal<typeof import('./eBilanzExportRepository')>(),
  assertCurrentEBalanceExport: current.export, assertCurrentEBalanceReport: current.report,
}))
const directory = mkdtempSync(join(tmpdir(), 'accounting-issue19-test-'))
const databasePath = join(directory, 'reports-test.db')
let prisma: typeof import('@/server/persistence/client').prisma
let retain: typeof import('./eBilanzReportStore').retainEBalanceReport
let actions: typeof import('./eBilanzReportActions')
let storage: ReturnType<typeof import('@/server/storage').getDocumentStorage>
let prepared: Awaited<ReturnType<typeof import('./eBilanzExportRepository').prepareAuthoritativeEBalanceExport>>
const fixture = eBilanz2026Fixture()
const ownerId = fixture.ownerId
let firstId: string
let secondId: string

beforeAll(async () => {
  vi.stubEnv('DATABASE_URL', `file:${databasePath.replaceAll('\\', '/')}`)
  vi.stubEnv('DOCUMENT_STORAGE_DRIVER', 'fs')
  vi.stubEnv('DOCUMENT_STORAGE_ROOT', join(directory, 'documents'))
  const db = new DatabaseSync(databasePath)
  for (const name of readdirSync('prisma/migrations').sort()) if (name !== 'migration_lock.toml') db.exec(readFileSync(resolve('prisma/migrations', name, 'migration.sql'), 'utf8'))
  db.close()
  prisma = (await import('@/server/persistence/client')).prisma
  retain = (await import('./eBilanzReportStore')).retainEBalanceReport
  actions = await import('./eBilanzReportActions')
  storage = (await import('@/server/storage')).getDocumentStorage()
  const officialArchive = readFileSync('public/taxonomies/german-gaap-taxonomy-v6.9-2025-04-01-xbrl.zip')
  const dataset = createAuthoritativeEBalanceDataset(fixture, readEBalanceTaxonomy(OFFICIAL_E_BALANCE_TAXONOMIES[0], officialArchive))
  const xml = serializeEBalanceFilingXml(dataset)
  const diagnostics = await (await import('./eBilanzSchemaValidation')).validateEBalanceFilingXml(xml, dataset, officialArchive)
  prepared = { dataset, xml, diagnostics, officialArchive, reportChecksum: eBalanceChecksum(xml), datasetChecksum: eBalanceChecksum(canonicalJson(dataset)), evidenceChecksum: 'd'.repeat(64) }
  await prisma.fiscalYear.create({ data: { id: fixture.fiscalYear.id, ownerId, year: 2026, startsAt: new Date(fixture.fiscalYear.startsAt), endsAt: new Date(fixture.fiscalYear.endsAt), status: 'CLOSED' } })
  await prisma.hgbCloseRun.create({ data: { id: 'hgb', ownerId, fiscalPeriodId: fixture.fiscalYear.id, version: 1, status: 'READY_TO_LOCK', ruleSetVersion: 'test', ledgerFingerprint: 'test', inputChecksum: 'test', checksum: 'test', payload: '{}', createdBy: 'preparer' } })
  await prisma.fiscalCloseGeneration.create({ data: { id: dataset.closeGenerationId, ownerId, fiscalYearId: fixture.fiscalYear.id, generation: 1, hgbCloseRunId: 'hgb', hgbCloseRunChecksum: 'test', snapshotHash: 'test', lockedAt: new Date() } })
})

afterAll(async () => {
  await prisma?.$disconnect()
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

async function publish(value = prepared, zip = false) {
  const id = randomUUID()
  const storageKey = `reports/${id}.${zip ? 'zip' : 'xml'}`
  const content = zip ? Buffer.from('synthetic retained ZIP bytes') : Buffer.from(value.xml)
  await storage.write(storageKey, content, { contentType: zip ? 'application/zip' : 'application/xml', fileName: storageKey })
  return prisma.$transaction(tx => retain(tx, { ownerId, actorId: 'preparer', id, prepared: value, storageKey, storageChecksum: eBalanceChecksum(content), status: zip ? 'EXPORTED' : 'PREPARED', reason: 'Synthetic reviewed close' }))
}
const approval = (reportId = firstId, reportChecksum = prepared.reportChecksum) => ({ reportId, reportChecksum, confirmed: true, reason: 'Reviewed exact retained report' })

describe('durable E-Bilanz report review and access', () => {
  test('given concurrent identical publications, retains one version and local diagnostics with calendar-year retention', async () => {
    const results = await Promise.all([publish(), publish()])
    firstId = results[0].report.id
    expect(results[1].report.id).toBe(firstId)
    expect(results.filter(result => result.created)).toHaveLength(1)
    const report = results[0].report
    expect(JSON.parse(report.validationDiagnostics!)).toMatchObject({ level: 'LOCAL_STRUCTURAL', officialAcceptance: 'NOT_VALIDATED', reportChecksum: report.reportChecksum })
    const artifact = await prisma.retainedArtifact.findFirstOrThrow({ where: { objectId: firstId } })
    const expectedYear = Math.max(new Date().getUTCFullYear(), 2027) + 10
    expect(artifact.retainUntil.toISOString()).toBe(`${expectedYear}-12-31T23:59:59.999Z`)
    expect(artifact.contentHash).toBe(report.reportChecksum)
    expect(current.export).toHaveBeenCalled()
  })

  test('given missing confirmation, a changed checksum or a foreign tenant, refuses approval without an event', async () => {
    await expect(actions.approveEBalanceReport(ownerId, 'reviewer', { ...approval(), confirmed: false })).rejects.toThrow('Confirm')
    await expect(actions.approveEBalanceReport(ownerId, 'reviewer', approval(firstId, 'wrong'))).rejects.toThrow('checksum')
    await expect(actions.approveEBalanceReport('foreign', 'reviewer', approval())).rejects.toThrow('not found')
    expect(await prisma.auditEvent.count({ where: { action: 'E_BILANZ_REPORT_APPROVED' } })).toBe(0)
  })

  test('given concurrent approval retries, preserves the first actor and one approval event', async () => {
    const approved = await Promise.all([actions.approveEBalanceReport(ownerId, 'reviewer', approval()), actions.approveEBalanceReport(ownerId, 'other-reviewer', approval())])
    expect(approved[0].approvedBy).toBe(approved[1].approvedBy)
    expect(approved[0].approvedAt).toEqual(approved[1].approvedAt)
    expect(approved[0].status).toBe('APPROVED')
    expect(await prisma.auditEvent.count({ where: { action: 'E_BILANZ_REPORT_APPROVED' } })).toBe(1)
    expect(current.report).toHaveBeenCalled()
  })

  test('given a corrected version, preserves its predecessor and records supersession without claiming submission', async () => {
    const xml = `${prepared.xml}\n`
    const corrected = { ...prepared, xml, reportChecksum: eBalanceChecksum(xml), diagnostics: { ...prepared.diagnostics, reportChecksum: eBalanceChecksum(xml) } }
    const second = await publish(corrected, true)
    secondId = second.report.id
    expect(second.report).toMatchObject({ version: 2, supersedesId: firstId, status: 'EXPORTED', approvedAt: null })
    expect((await prisma.eBalanceLifecycleReport.findUniqueOrThrow({ where: { id: firstId } })).status).toBe('APPROVED')
    await expect(actions.approveEBalanceReport(ownerId, 'reviewer', approval())).rejects.toThrow('superseded')
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'E_BILANZ_REPORT_SUPERSEDED' } })
    expect(event.objectId).toBe(firstId)
    expect(JSON.parse(event.semanticDelta).after.successorId).toBe(secondId)
    expect(await prisma.eBalanceSubmission.count()).toBe(0)
  })

  test('given stale sources, refuses approval of even the newest retained version', async () => {
    const second = await prisma.eBalanceLifecycleReport.findUniqueOrThrow({ where: { id: secondId } })
    current.report.mockRejectedValueOnce(new Error('Reconciliation changed'))
    await expect(actions.approveEBalanceReport(ownerId, 'reviewer', approval(secondId, second.reportChecksum))).rejects.toThrow('Reconciliation changed')
    expect((await prisma.eBalanceLifecycleReport.findUniqueOrThrow({ where: { id: secondId } })).approvedAt).toBeNull()
  })

  test('given corrupted retained bytes, refuses approval even when source checks still pass', async () => {
    const report = await prisma.eBalanceLifecycleReport.findUniqueOrThrow({ where: { id: secondId } })
    await storage.write(report.storageKey, Buffer.from('corrupted'), { contentType: 'application/zip', fileName: 'report.zip' })
    await expect(actions.approveEBalanceReport(ownerId, 'reviewer', approval(secondId, report.reportChecksum))).rejects.toThrow('checksum')
    expect((await prisma.eBalanceLifecycleReport.findUniqueOrThrow({ where: { id: secondId } })).approvedAt).toBeNull()
    await storage.write(report.storageKey, Buffer.from('synthetic retained ZIP bytes'), { contentType: 'application/zip', fileName: 'report.zip' })
  })

  test('given historical XML and ZIP artifacts, downloads exact stored bytes and audits the real actor', async () => {
    expect((await actions.downloadEBalanceReport(ownerId, 'reader', firstId)).content.toString()).toBe(prepared.xml)
    const downloaded = await actions.downloadEBalanceReport(ownerId, 'reader', secondId)
    expect(downloaded.contentType).toBe('application/zip')
    expect(downloaded.content.toString()).toBe('synthetic retained ZIP bytes')
    expect(await prisma.auditEvent.count({ where: { action: 'E_BILANZ_REPORT_ACCESSED', actorId: 'reader' } })).toBe(2)
    await expect(actions.downloadEBalanceReport('foreign', 'reader', firstId)).rejects.toThrow('not found')
  })

  test('given tampered storage, refuses access without recording a successful download', async () => {
    const report = await prisma.eBalanceLifecycleReport.findUniqueOrThrow({ where: { id: firstId } })
    await storage.write(report.storageKey, Buffer.from('tampered'), { contentType: 'application/xml', fileName: 'report.xml' })
    await expect(actions.downloadEBalanceReport(ownerId, 'reader', firstId)).rejects.toThrow('checksum')
    expect(await prisma.auditEvent.count({ where: { action: 'E_BILANZ_REPORT_ACCESSED' } })).toBe(2)
    await storage.write(report.storageKey, Buffer.from(prepared.xml), { contentType: 'application/xml', fileName: 'report.xml' })
  })

  test('given an audit failure, rolls back approval and leaves the audit chain intact', async () => {
    const db = new DatabaseSync(databasePath)
    db.exec(`CREATE TRIGGER reject_report_approval BEFORE INSERT ON AuditEvent WHEN NEW.action = 'E_BILANZ_REPORT_APPROVED' BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END;`)
    const report = await prisma.eBalanceLifecycleReport.findUniqueOrThrow({ where: { id: secondId } })
    await expect(actions.approveEBalanceReport(ownerId, 'reviewer', approval(secondId, report.reportChecksum))).rejects.toThrow()
    expect((await prisma.eBalanceLifecycleReport.findUniqueOrThrow({ where: { id: secondId } })).approvedAt).toBeNull()
    db.exec('DROP TRIGGER reject_report_approval'); db.close()
    const events = await prisma.auditEvent.findMany({ where: { ownerId } })
    expect(verifyAuditChain(events, await prisma.auditHead.findUnique({ where: { ownerId } }))).toBe(true)
  })

  test('given direct database edits, rejects rewritten identity, approval and diagnostics', async () => {
    const db = new DatabaseSync(databasePath)
    for (const data of [{ createdBy: 'forged' }, { approvedBy: 'forged' }, { approvedAt: null }, { validationDiagnostics: '{}' }, { validationEngine: 'forged' }, { validatedAt: null }]) {
      const [field, value] = Object.entries(data)[0]
      expect(() => db.prepare(`UPDATE EBalanceLifecycleReport SET ${field} = ? WHERE id = ?`).run(value, firstId)).toThrow('immutable')
    }
    db.close()
  })

  test('given disposed retained evidence, refuses historical access and current approval', async () => {
    const artifact = await prisma.retainedArtifact.findFirstOrThrow({ where: { objectId: secondId } })
    await prisma.retainedArtifact.update({ where: { id: artifact.id }, data: { disposedAt: new Date() } })
    const report = await prisma.eBalanceLifecycleReport.findUniqueOrThrow({ where: { id: secondId } })
    await expect(actions.downloadEBalanceReport(ownerId, 'reader', secondId)).rejects.toThrow('unavailable')
    await expect(actions.approveEBalanceReport(ownerId, 'reviewer', approval(secondId, report.reportChecksum))).rejects.toThrow('unavailable')
  })
})
