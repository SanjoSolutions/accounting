import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { canonicalJson, createAuditPackage, importMigrationPackage, verifyAuditPackage, type AuditExportSource, type MigrationPackageAuthenticator } from './auditExport'

const tenantId = 'tenant-cycle-42'
const access = { tenantId, actorId: 'auditor', authorityReference: 'AO-2026-42', accessedAt: '2026-07-18T23:00:00Z', purpose: 'AUDIT' as const }
const authenticator: MigrationPackageAuthenticator = { keyId: 'cycle-42-anchor', sign: payload => createHash('sha256').update(`anchor:${payload}`).digest('hex'), verify(payload, signature, keyId) { return keyId === this.keyId && signature === this.sign(payload) } }

function source(): AuditExportSource {
  return { masterData: [], chartMappings: [{ tenantId, accountId: '1000', name: 'Cash' }, { tenantId, accountId: '2000', name: 'Equity' }], fiscalYears: [{ tenantId, id: 'FY-2026', startDate: '2026-01-01', endDate: '2026-12-31' }], journal: [{ tenantId, id: 'j-1', fiscalYearId: 'FY-2026', sequenceNumber: 1, bookingDate: '2026-06-30', documentNumber: 'D-1', description: 'Posting' }], journalLines: [{ tenantId, id: 'l-1', journalEntryId: 'j-1', accountId: '1000', debitCents: 50, creditCents: 0 }, { tenantId, id: 'l-2', journalEntryId: 'j-1', accountId: '2000', debitCents: 0, creditCents: 50 }], openingClosing: [{ tenantId, fiscalYearId: 'FY-2026', accountId: '1000', openingCents: 100, closingCents: 150 }, { tenantId, fiscalYearId: 'FY-2026', accountId: '2000', openingCents: -100, closingCents: -150 }], vatDetails: [], evidence: [], auditEvents: [], taxSubmissions: [], openItems: [] }
}

describe('cycle 42 audit snapshot and CSV coercion boundaries', () => {
  it('rejects accessor-backed package layers and never consumes getter-swapped dataset bytes', async () => {
    const migration = await createAuditPackage(source(), { ...access, purpose: 'MIGRATION' }, { record: vi.fn() }, authenticator)
    let fileReads = 0
    const files = Object.create(null) as Record<string, string>
    for (const [path, contents] of Object.entries(migration.files)) Object.defineProperty(files, path, path === 'data/masterData.json' ? { enumerable: true, get: () => fileReads++ === 0 ? contents : canonicalJson([{ tenantId: 'other-tenant', id: 'swapped' }]) } : { enumerable: true, value: contents })
    const fileAccessor = { ...migration, files }
    expect(verifyAuditPackage(fileAccessor)).toContain('Audit package files map must use own data properties without accessors')
    expect(() => importMigrationPackage(fileAccessor, tenantId, authenticator)).toThrow('without accessors')
    expect(fileReads).toBe(0)

    const manifest = { ...migration.manifest }; Object.defineProperty(manifest, 'tenantId', { enumerable: true, get: () => tenantId })
    expect(verifyAuditPackage({ ...migration, manifest })).toContain('Audit package manifest must use own data properties without accessors')
    const entries = migration.manifest.files.map(entry => ({ ...entry })); Object.defineProperty(entries[0], 'sha256', { enumerable: true, get: () => migration.manifest.files[0].sha256 })
    expect(verifyAuditPackage({ ...migration, manifest: { ...migration.manifest, files: entries } })).toContain('Manifest file entry 0 must use own data properties without accessors')
    const outer = { files: migration.files, authenticity: migration.authenticity } as Record<string, unknown>; Object.defineProperty(outer, 'manifest', { enumerable: true, get: () => migration.manifest })
    expect(verifyAuditPackage(outer)).toContain('Audit package outer object must use own data properties without accessors')
  })

  it('rejects non-string report text even when coercion could produce a formula and preserves negative numeric cells', async () => {
    const arrayName = source(); arrayName.chartMappings = arrayName.chartMappings.map((row, index) => index ? row : { ...row, name: ['=HYPERLINK("https://evil")'] })
    await expect(createAuditPackage(arrayName, access, { record: vi.fn() })).rejects.toThrow('chartMappings.name is required text')
    const objectDocument = source(); objectDocument.journal = objectDocument.journal.map(row => ({ ...row, documentNumber: { toString: () => '=HYPERLINK("https://evil")' } }))
    await expect(createAuditPackage(objectDocument, access, { record: vi.fn() })).rejects.toThrow('journal.documentNumber is required text')
    const formula = source(); formula.journal = formula.journal.map(row => ({ ...row, description: '=HYPERLINK("https://evil")' }))
    const report = (await createAuditPackage(formula, access, { record: vi.fn() })).files['reports/Hauptbuch-Kontenblaetter.csv']
    expect(report).toContain("'=HYPERLINK")
    expect(report).toContain('"-100"')
    expect(report).not.toContain('"\'-100"')
  })
})
