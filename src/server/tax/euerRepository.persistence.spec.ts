import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const directory = mkdtempSync(join(tmpdir(), 'accounting-euer-'))
const databasePath = join(directory, 'test.db').replaceAll('\\', '/')
let api: typeof import('./euerRepository')
let prisma: typeof import('@/server/persistence/client').prisma
const profile = { companyName: 'Synthetic sole trader', legalForm: 'SOLE_TRADER', taxNumber: '123/456/78901', taxOffice: 'Berlin', activity: 'Consulting', vatRegime: 'STANDARD', vatFilingFrequency: 'MONTHLY', sizeClass: 'MICRO', chart: 'SKR03', elections: [], soleTraderTaxProfile: { profitDetermination: 'EUER', incomeType: 'SELF_EMPLOYED', euerEligibilityConfirmed: true } }
const request = (requestKey: string, baseVersion = 0) => ({ year: 2026, baseVersion, requestKey, input: { entries: [{ id: 'payment', paymentDate: '2026-06-01', position: 'taxableReceipts', amountCents: 10000, reference: 'SYNTHETIC-1', description: 'Received payment' }], scopeConfirmed: true } })

beforeAll(async () => {
  const database = new DatabaseSync(databasePath)
  const migrations = resolve('prisma/migrations')
  for (const name of readdirSync(migrations, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort()) database.exec(readFileSync(join(migrations, name, 'migration.sql'), 'utf8'))
  database.close()
  process.env.DATABASE_URL = `file:${databasePath}`
  api = await import('./euerRepository')
  prisma = (await import('@/server/persistence/client')).prisma
  for (const ownerId of ['euer-a', 'euer-b', 'euer-concurrent', 'euer-rollback']) {
    await prisma.fiscalYear.create({ data: { ownerId, year: 2026, startsAt: new Date('2026-01-01'), endsAt: new Date('2026-12-31T23:59:59.999Z') } })
    await prisma.companyProfileVersion.create({ data: { ownerId, effectiveFrom: new Date('2026-01-01'), payload: JSON.stringify(profile), createdBy: 'profile-actor', reason: 'Synthetic initial facts' } })
  }
}, 120000)
afterAll(async () => { await prisma?.$disconnect(); rmSync(directory, { recursive: true, force: true }) })

describe('persistent EÜR workpapers', () => {
  test('Given a tenant and delegated actor, when saving and retrying, then one immutable revision and actor-correct audit event survive reload', async () => {
    const saved = await api.saveEuerRevision('euer-a', 'accountant-a', request('euer-save-request-0001'))
    expect(saved).toMatchObject({ version: 1, report: { profitCents: 10000 } })
    expect(await api.saveEuerRevision('euer-a', 'accountant-a', request('euer-save-request-0001'))).toEqual(saved)
    expect(await prisma.euerRevision.count({ where: { ownerId: 'euer-a' } })).toBe(1)
    expect(await prisma.auditEvent.findMany({ where: { ownerId: 'euer-a', action: 'EUER_WORKPAPER_SAVED' } })).toEqual([expect.objectContaining({ actorId: 'accountant-a' })])
    expect(await api.getEuerWorkspace('euer-a', 2026)).toMatchObject({ version: 1, profileChanged: false, report: saved.report })
    expect(await api.getEuerWorkspace('euer-b', 2026)).toMatchObject({ version: 0, report: { input: { entries: [] } } })
    await expect(api.exportEuer('euer-b', 2026, 1)).rejects.toThrow(/changed/)
    await expect(api.saveEuerRevision('euer-a', 'other-actor', request('euer-save-request-0001'))).rejects.toThrow(/different/)
    // Assert the actual SQLite guard, rather than Prisma's lossy P2003 mapping.
    const raw = new DatabaseSync(databasePath)
    try {
      expect(() => raw.prepare("UPDATE EuerRevision SET payload = '{}' WHERE ownerId = 'euer-a'").run()).toThrow(/immutable/)
      expect(() => raw.prepare("DELETE FROM EuerRevision WHERE ownerId = 'euer-a'").run()).toThrow(/immutable/)
    } finally { raw.close() }
    expect(await api.exportEuer('euer-a', 2026, 1)).toContain('100,00')
  })
  test('Given two sessions with the same base version, when both save, then only one new revision commits', async () => {
    const results = await Promise.allSettled([
      api.saveEuerRevision('euer-concurrent', 'actor', request('euer-concurrent-save-01')),
      api.saveEuerRevision('euer-concurrent', 'actor', request('euer-concurrent-save-02')),
    ])
    expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    expect(await prisma.euerRevision.count({ where: { ownerId: 'euer-concurrent' } })).toBe(1)
    await expect(api.saveEuerRevision('euer-concurrent', 'actor', request('euer-concurrent-save-03'))).rejects.toThrow(/another session/)
  })
  test('Given a saved workpaper, when revising, then older evidence remains and stale exports fail', async () => {
    const next = request('euer-save-request-0002', 1)
    next.input.entries[0].amountCents = 9000
    await api.saveEuerRevision('euer-a', 'accountant-a', next)
    expect((await api.getEuerWorkspace('euer-a', 2026)).history.map(row => row.version)).toEqual([2, 1])
    await expect(api.exportEuer('euer-a', 2026, 1)).rejects.toThrow(/changed/)
    expect(await api.exportEuer('euer-a', 2026, 2)).toContain('90,00')
    expect(JSON.parse((await prisma.euerRevision.findFirstOrThrow({ where: { ownerId: 'euer-a', version: 1 } })).payload).profitCents).toBe(10000)
  })
  test('Given changed authoritative profile facts, when exporting, then review is required before a new revision can be exported', async () => {
    await prisma.companyProfileVersion.create({ data: { ownerId: 'euer-a', effectiveFrom: new Date('2026-01-01T00:00:00.001Z'), payload: JSON.stringify({ ...profile, companyName: 'Corrected sole trader' }), createdBy: 'profile-actor', reason: 'Synthetic corrected identity' } })
    expect(await api.getEuerWorkspace('euer-a', 2026)).toMatchObject({ profileChanged: true })
    await expect(api.exportEuer('euer-a', 2026, 2)).rejects.toThrow(/profile changed/)
    const next = request('euer-save-request-0003', 2); next.input.scopeConfirmed = false
    await api.saveEuerRevision('euer-a', 'accountant-a', next)
    await expect(api.exportEuer('euer-a', 2026, 3)).rejects.toThrow(/Review/)
  })
  test('Given an audit-write failure, when saving, then the revision and audit head roll back together', async () => {
    await prisma.$executeRawUnsafe(`CREATE TRIGGER euer_test_audit_failure BEFORE INSERT ON AuditEvent WHEN NEW.ownerId = 'euer-rollback' BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END`)
    await expect(api.saveEuerRevision('euer-rollback', 'actor', request('euer-rollback-request-1'))).rejects.toThrow()
    expect(await prisma.euerRevision.count({ where: { ownerId: 'euer-rollback' } })).toBe(0)
    expect(await prisma.auditHead.findUnique({ where: { ownerId: 'euer-rollback' } })).toBeNull()
  })
  test('Given a locked fiscal year or missing tenant setup, when saving, then no new workpaper is created', async () => {
    await prisma.fiscalYear.update({ where: { ownerId_year: { ownerId: 'euer-b', year: 2026 } }, data: { status: 'LOCKED' } })
    await expect(api.saveEuerRevision('euer-b', 'actor', request('euer-locked-request-01'))).rejects.toThrow(/locked/)
    await expect(api.saveEuerRevision('unknown', 'actor', request('euer-unknown-request-1'))).rejects.toThrow(/calendar fiscal year/)
    await expect(api.getEuerWorkspace('euer-b', 2026)).resolves.toMatchObject({ locked: true })
  })
})
