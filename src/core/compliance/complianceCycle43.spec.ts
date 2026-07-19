import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { canonicalJson, createAuditPackage, importMigrationPackage, verifyAuditPackage, type AuditExportSource, type AuditPackage, type MigrationPackageAuthenticator } from './auditExport'
import { calculatePartialYearDepreciation, closePhysicalInventory, createAssetSchedules, type FixedAsset } from './assetsInventory'

const tenantId = 'tenant-cycle-43'
const access = { tenantId, actorId: 'auditor', authorityReference: 'AO-2026-43', accessedAt: '2026-07-18T23:30:00Z', purpose: 'AUDIT' as const }
const authenticator: MigrationPackageAuthenticator = { keyId: 'cycle-43-anchor', sign: payload => createHash('sha256').update(`anchor:${payload}`).digest('hex'), verify(payload, signature, keyId) { return keyId === this.keyId && signature === this.sign(payload) } }
const emptySource = (): AuditExportSource => ({ masterData: [], chartMappings: [], fiscalYears: [], journal: [], journalLines: [], openingClosing: [], vatDetails: [], evidence: [], auditEvents: [], taxSubmissions: [], openItems: [] })
const fiscalYear = (id: string, startDate: string, endDate: string) => ({ tenantId, id, startDate, endDate })
const asset = (): FixedAsset => ({ id: 'asset-1', tenantId, description: 'Machine', costCents: 1200, acquisitionDate: '2026-01-01', availableForUseDate: '2026-01-01', location: 'Berlin', usefulLifeMonths: 12, method: 'STRAIGHT_LINE', taxUsefulLifeMonths: 12, taxMethod: 'STRAIGHT_LINE', evidenceIds: ['invoice'] })

function rehashFile(auditPackage: AuditPackage, path: string, contents: string): AuditPackage { const files = { ...auditPackage.files, [path]: contents }; const manifestFiles = auditPackage.manifest.files.map(file => file.path === path ? { ...file, bytes: Buffer.byteLength(contents), sha256: createHash('sha256').update(contents).digest('hex'), rows: (JSON.parse(contents) as unknown[]).length } : file); const { packageChecksum: _old, ...checksumInput } = { ...auditPackage.manifest, files: manifestFiles }; const manifest = { ...checksumInput, files: manifestFiles, packageChecksum: createHash('sha256').update(canonicalJson(checksumInput)).digest('hex') }; const authenticityPayload = canonicalJson({ format: manifest.format, version: manifest.version, tenantId: manifest.tenantId, purpose: manifest.purpose, packageChecksum: manifest.packageChecksum }); return { ...auditPackage, files, manifest, ...(auditPackage.authenticity ? { authenticity: { ...auditPackage.authenticity, signature: authenticator.sign(authenticityPayload) } } : {}) } }

describe('cycle 43 fiscal-year and useful-life boundaries', () => {
  it('allows short and deviating non-overlapping fiscal years but rejects periods over twelve months and inclusive overlaps', async () => {
    const valid = emptySource(); valid.fiscalYears = [fiscalYear('FY-1', '2025-04-01', '2026-03-31'), fiscalYear('FY-2', '2026-04-01', '2026-09-30'), fiscalYear('FY-3', '2026-10-01', '2026-12-31')]
    await expect(createAuditPackage(valid, access, { record: vi.fn() })).resolves.toBeDefined()
    const tooLong = emptySource(); tooLong.fiscalYears = [fiscalYear('FY-LONG', '2025-01-01', '2026-01-01')]
    await expect(createAuditPackage(tooLong, access, { record: vi.fn() })).rejects.toThrow('may not exceed twelve months')
    const overlap = emptySource(); overlap.fiscalYears = [fiscalYear('FY-1', '2025-04-01', '2026-03-31'), fiscalYear('FY-2', '2026-03-31', '2026-12-31')]
    await expect(createAuditPackage(overlap, access, { record: vi.fn() })).rejects.toThrow('Fiscal-year periods overlap')
  })

  it('rejects rehashed overlapping fiscal years during verification and before authenticated import', async () => {
    const valid = emptySource(); valid.fiscalYears = [fiscalYear('FY-1', '2025-04-01', '2026-03-31'), fiscalYear('FY-2', '2026-04-01', '2026-12-31')]
    const migration = await createAuditPackage(valid, { ...access, purpose: 'MIGRATION' }, { record: vi.fn() }, authenticator)
    const forged = rehashFile(migration, 'data/fiscalYears.json', canonicalJson([fiscalYear('FY-1', '2025-04-01', '2026-03-31'), fiscalYear('FY-2', '2026-03-01', '2026-12-31')]))
    expect(verifyAuditPackage(forged)).toEqual(expect.arrayContaining([expect.stringContaining('Fiscal-year periods overlap')]))
    expect(() => importMigrationPackage(forged, tenantId, authenticator)).toThrow(/^Invalid audit package:/)
  })

  it('requires safe positive book and tax useful-life month counts at every asset boundary', () => {
    for (const field of ['usefulLifeMonths', 'taxUsefulLifeMonths'] as const) { const unsafe = { ...asset(), [field]: Number.MAX_SAFE_INTEGER + 1 }; expect(() => calculatePartialYearDepreciation(unsafe, { start: '2026-01-01', end: '2026-12-31' }, field === 'usefulLifeMonths' ? 'BOOK' : 'TAX')).toThrow('useful lives'); expect(() => createAssetSchedules(tenantId, [unsafe], [], { start: '2026-01-01', end: '2026-12-31' })).toThrow('useful lives') }
  })

  it('rejects asset-schedule and physical-inventory periods longer than twelve months', () => {
    const period = { start: '2025-01-01', end: '2026-01-01' }
    expect(() => createAssetSchedules(tenantId, [], [], period)).toThrow('may not exceed twelve months')
    expect(() => closePhysicalInventory(tenantId, { ...period, timeZone: 'Europe/Berlin' }, [], [], '2026-01-02T10:00:00Z')).toThrow('may not exceed twelve months')
    expect(() => createAssetSchedules(tenantId, [], [], { start: '2025-04-01', end: '2026-03-31' })).not.toThrow()
  })
})
