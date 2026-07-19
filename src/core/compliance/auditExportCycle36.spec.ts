import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { canonicalJson, createAuditPackage, importMigrationPackage, verifyAuditPackage, type AuditExportSource, type AuditPackage, type MigrationPackageAuthenticator } from './auditExport'

const tenantId = 'tenant-cycle-36'
const access = { tenantId, actorId: 'auditor', authorityReference: 'AO-2026-36', accessedAt: '2026-07-18T22:00:00Z', purpose: 'AUDIT' as const }
const emptySource = (): AuditExportSource => ({ masterData: [], chartMappings: [], fiscalYears: [], journal: [], journalLines: [], openingClosing: [], vatDetails: [], evidence: [], auditEvents: [], taxSubmissions: [] })

function vatSource(): AuditExportSource {
  return { ...emptySource(), chartMappings: [{ tenantId, accountId: '1000', name: 'Cash' }, { tenantId, accountId: '8000', name: 'Revenue' }], fiscalYears: [{ tenantId, id: 'FY-2026', startDate: '2026-01-01', endDate: '2026-12-31' }], journal: [{ tenantId, id: 'j-1', fiscalYearId: 'FY-2026', sequenceNumber: 1, bookingDate: '2026-06-30', documentNumber: 'D-1', description: 'Sale' }], journalLines: [{ tenantId, id: 'l-1', journalEntryId: 'j-1', accountId: '1000', debitCents: 119, creditCents: 0 }, { tenantId, id: 'l-2', journalEntryId: 'j-1', accountId: '8000', debitCents: 0, creditCents: 119 }], openingClosing: [{ tenantId, fiscalYearId: 'FY-2026', accountId: '1000', openingCents: 0, closingCents: 119 }, { tenantId, fiscalYearId: 'FY-2026', accountId: '8000', openingCents: 0, closingCents: -119 }], vatDetails: [{ tenantId, id: 'vat-1', journalLineId: 'l-1', taxCode: 'U19', baseCents: 100, taxAmountCents: 19, returnPeriod: '2026-06', submissionId: 'sub-1' }], taxSubmissions: [{ tenantId, id: 'sub-1', fiscalYearId: 'FY-2026', kind: 'VAT', returnPeriod: '2026-06', status: 'ACCEPTED' }] }
}

const authenticator: MigrationPackageAuthenticator = { keyId: 'cycle-36-anchor', sign: value => createHash('sha256').update(`anchor:${value}`).digest('hex'), verify(value, signature, keyId) { return keyId === this.keyId && signature === this.sign(value) } }
function rehashFile(auditPackage: AuditPackage, path: string, contents: string): AuditPackage { const files = { ...auditPackage.files, [path]: contents }; const manifestFiles = auditPackage.manifest.files.map(file => file.path === path ? { ...file, bytes: Buffer.byteLength(contents), sha256: createHash('sha256').update(contents).digest('hex'), rows: (JSON.parse(contents) as unknown[]).length } : file); const { packageChecksum: _old, ...checksumInput } = { ...auditPackage.manifest, files: manifestFiles }; const manifest = { ...checksumInput, files: manifestFiles, packageChecksum: createHash('sha256').update(canonicalJson(checksumInput)).digest('hex') }; const authenticityPayload = canonicalJson({ format: manifest.format, version: manifest.version, tenantId: manifest.tenantId, purpose: manifest.purpose, packageChecksum: manifest.packageChecksum }); return { ...auditPackage, files, manifest, ...(auditPackage.authenticity ? { authenticity: { ...auditPackage.authenticity, signature: authenticator.sign(authenticityPayload) } } : {}) } }

describe('cycle 36 mandatory adapter arrays and VAT submission periods', () => {
  it('requires an actual array for every mandatory adapter dataset before filtering or audit logging', async () => {
    const mandatory = ['masterData', 'chartMappings', 'fiscalYears', 'journal', 'journalLines', 'openingClosing', 'vatDetails', 'evidence', 'auditEvents', 'taxSubmissions'] as const
    for (const name of mandatory) for (const invalidValue of [undefined, null]) {
      const invalid = { ...emptySource(), [name]: invalidValue } as unknown as AuditExportSource; const sink = { record: vi.fn() }
      await expect(createAuditPackage(invalid, access, sink)).rejects.toThrow(`dataset ${name} must be an array`)
      expect(sink.record).not.toHaveBeenCalled()
    }
    await expect(createAuditPackage(emptySource(), access, { record: vi.fn() })).resolves.toBeDefined()
    await expect(createAuditPackage({ ...emptySource(), openItems: null } as unknown as AuditExportSource, access, { record: vi.fn() })).rejects.toThrow('dataset openItems must be an array')
  })

  it('preflights every adapter row tenant contract before tenant filtering while allowing valid foreign rows', async () => {
    const datasets = ['masterData', 'chartMappings', 'fiscalYears', 'journal', 'journalLines', 'openingClosing', 'vatDetails', 'evidence', 'auditEvents', 'taxSubmissions', 'openItems'] as const
    for (const name of datasets) for (const row of [null, true, [], 'row', {}, { tenantId: '' }, { tenantId: 1 }]) {
      const invalid = { ...emptySource(), [name]: [row] } as unknown as AuditExportSource; const sink = { record: vi.fn() }
      await expect(createAuditPackage(invalid, access, sink)).rejects.toThrow(`dataset ${name} row 0 must be a plain object with a nonblank string tenantId`)
      expect(sink.record).not.toHaveBeenCalled()
    }
    const foreignOnly = Object.fromEntries(datasets.map(name => [name, [{ tenantId: 'foreign-tenant' }]])) as unknown as AuditExportSource
    await expect(createAuditPackage(foreignOnly, access, { record: vi.fn() })).resolves.toBeDefined()
  })

  it('requires every VAT submission to declare a real authoritative return period', async () => {
    const missing = vatSource(); missing.taxSubmissions = missing.taxSubmissions.map(({ returnPeriod: _missing, ...row }) => row)
    await expect(createAuditPackage(missing, access, { record: vi.fn() })).rejects.toThrow('taxSubmissions.returnPeriod is required text')
    const invalid = vatSource(); invalid.taxSubmissions = invalid.taxSubmissions.map(row => ({ ...row, returnPeriod: '2026-13' }))
    await expect(createAuditPackage(invalid, access, { record: vi.fn() })).rejects.toThrow('authoritative real returnPeriod')
  })

  it('rejects a June VAT detail linked to a July submission during creation, verification and import', async () => {
    const mismatch = vatSource(); mismatch.taxSubmissions = mismatch.taxSubmissions.map(row => ({ ...row, returnPeriod: '2026-07' }))
    await expect(createAuditPackage(mismatch, access, { record: vi.fn() })).rejects.toThrow('exact return period')
    const valid = await createAuditPackage(vatSource(), { ...access, purpose: 'MIGRATION' }, { record: vi.fn() }, authenticator)
    const forgedRows = vatSource().taxSubmissions.map(row => ({ ...row, returnPeriod: '2026-07' }))
    const forged = rehashFile(valid, 'data/taxSubmissions.json', canonicalJson(forgedRows))
    expect(verifyAuditPackage(forged)).toEqual(expect.arrayContaining([expect.stringContaining('exact return period')]))
    expect(() => importMigrationPackage(forged, tenantId, authenticator)).toThrow(/^Invalid audit package:/)
  })

  it('binds VAT return months to inclusive non-calendar and short fiscal-year boundaries', async () => {
    const nonCalendar = (returnPeriod: string, bookingDate = '2025-06-15') => { const value = vatSource(); value.fiscalYears = value.fiscalYears.map(row => ({ ...row, startDate: '2025-04-15', endDate: '2026-03-14' })); value.journal = value.journal.map(row => ({ ...row, bookingDate })); value.vatDetails = value.vatDetails.map(row => ({ ...row, returnPeriod })); value.taxSubmissions = value.taxSubmissions.map(row => ({ ...row, returnPeriod })); return value }
    await expect(createAuditPackage(nonCalendar('2025-04', '2025-04-15'), access, { record: vi.fn() })).resolves.toBeDefined()
    await expect(createAuditPackage(nonCalendar('2026-03', '2026-03-14'), access, { record: vi.fn() })).resolves.toBeDefined()
    await expect(createAuditPackage(nonCalendar('2025-03'), access, { record: vi.fn() })).rejects.toThrow('must fall within its referenced fiscal year')
    await expect(createAuditPackage(nonCalendar('2026-04'), access, { record: vi.fn() })).rejects.toThrow('must fall within its referenced fiscal year')
    const shortYear = nonCalendar('2026-06', '2026-06-15'); shortYear.fiscalYears = shortYear.fiscalYears.map(row => ({ ...row, startDate: '2026-06-01', endDate: '2026-06-30' })); await expect(createAuditPackage(shortYear, access, { record: vi.fn() })).resolves.toBeDefined()
    for (const outside of ['2026-05', '2026-07']) { const invalid = { ...shortYear, vatDetails: shortYear.vatDetails.map(row => ({ ...row, returnPeriod: outside })), taxSubmissions: shortYear.taxSubmissions.map(row => ({ ...row, returnPeriod: outside })) }; await expect(createAuditPackage(invalid, access, { record: vi.fn() })).rejects.toThrow('must fall within its referenced fiscal year') }
  })
})
