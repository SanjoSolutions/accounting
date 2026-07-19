import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { canonicalJson, createAuditPackage, importMigrationPackage, reconcileRoundTrip, verifyAuditPackage, type AuditExportSource, type AuditPackage, type MigrationPackageAuthenticator } from './auditExport'

const tenantId = 'tenant-cycle-34'
const access = { tenantId, actorId: 'auditor', authorityReference: 'AO-2026-34', accessedAt: '2026-07-18T21:00:00Z', purpose: 'AUDIT' as const }
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

function source(): AuditExportSource {
  const oldBytes = new Uint8Array([1]); const newBytes = new Uint8Array([2])
  return {
    masterData: [{ tenantId, id: 'z-company' }, { tenantId, id: 'a-contact' }],
    chartMappings: [{ tenantId, accountId: 'z-cash', name: 'Cash' }, { tenantId, accountId: 'a-revenue', name: 'Revenue' }],
    fiscalYears: [{ tenantId, id: 'z-old', startDate: '2025-01-01', endDate: '2025-12-31' }, { tenantId, id: 'a-new', startDate: '2026-01-01', endDate: '2026-12-31' }],
    journal: [{ tenantId, id: 'z-old-journal', fiscalYearId: 'z-old', sequenceNumber: 1, bookingDate: '2025-06-30', documentNumber: 'OLD', description: 'Old year' }, { tenantId, id: 'a-new-journal', fiscalYearId: 'a-new', sequenceNumber: 1, bookingDate: '2026-06-30', documentNumber: 'NEW', description: 'New year' }],
    journalLines: [{ tenantId, id: 'z-old-debit', journalEntryId: 'z-old-journal', accountId: 'z-cash', debitCents: 100, creditCents: 0 }, { tenantId, id: 'y-old-credit', journalEntryId: 'z-old-journal', accountId: 'a-revenue', debitCents: 0, creditCents: 100 }, { tenantId, id: 'b-new-debit', journalEntryId: 'a-new-journal', accountId: 'z-cash', debitCents: 50, creditCents: 0 }, { tenantId, id: 'a-new-credit', journalEntryId: 'a-new-journal', accountId: 'a-revenue', debitCents: 0, creditCents: 50 }],
    openingClosing: [{ tenantId, fiscalYearId: 'z-old', accountId: 'z-cash', openingCents: 0, closingCents: 100 }, { tenantId, fiscalYearId: 'z-old', accountId: 'a-revenue', openingCents: 0, closingCents: -100 }, { tenantId, fiscalYearId: 'a-new', accountId: 'z-cash', openingCents: 100, closingCents: 150 }, { tenantId, fiscalYearId: 'a-new', accountId: 'a-revenue', openingCents: -100, closingCents: -150 }],
    vatDetails: [{ tenantId, id: 'z-vat-old', journalLineId: 'z-old-debit', taxCode: 'U19', baseCents: 84, taxAmountCents: 16, returnPeriod: '2025-06', submissionId: 'z-sub-old' }, { tenantId, id: 'a-vat-new', journalLineId: 'b-new-debit', taxCode: 'U19', baseCents: 42, taxAmountCents: 8, returnPeriod: '2026-06', submissionId: 'a-sub-new' }],
    evidence: [{ tenantId, id: 'z-evidence', journalEntryId: 'z-old-journal', fileName: 'old.bin', mediaType: 'application/octet-stream', bytes: oldBytes, sizeBytes: 1, sha256: digest(oldBytes) }, { tenantId, id: 'a-evidence', journalEntryId: 'a-new-journal', fileName: 'new.bin', mediaType: 'application/octet-stream', bytes: newBytes, sizeBytes: 1, sha256: digest(newBytes) }],
    auditEvents: [{ tenantId, id: 'z-audit', action: 'POST', targetId: 'z-old-journal' }, { tenantId, id: 'a-audit', action: 'POST', targetId: 'a-new-journal' }],
    taxSubmissions: [{ tenantId, id: 'z-sub-old', fiscalYearId: 'z-old', kind: 'VAT', returnPeriod: '2025-06', status: 'ACCEPTED' }, { tenantId, id: 'a-sub-new', fiscalYearId: 'a-new', kind: 'VAT', returnPeriod: '2026-06', status: 'ACCEPTED' }],
    openItems: [{ tenantId, id: 'z-open', outstandingCents: 100 }, { tenantId, id: 'a-open', outstandingCents: 50 }],
  }
}

const authenticator: MigrationPackageAuthenticator = { keyId: 'cycle-34-anchor', sign: value => createHash('sha256').update(`anchor:${value}`).digest('hex'), verify(value, signature, keyId) { return keyId === this.keyId && signature === this.sign(value) } }

function replaceAndRehashFile(auditPackage: AuditPackage, path: string, contents: string): AuditPackage {
  const files = { ...auditPackage.files, [path]: contents }
  const manifestFiles = auditPackage.manifest.files.map(file => file.path === path ? { ...file, bytes: Buffer.byteLength(contents, 'utf8'), sha256: digest(Buffer.from(contents, 'utf8')), ...(file.rows !== undefined ? { rows: (JSON.parse(contents) as unknown[]).length } : {}) } : file)
  const { packageChecksum: _packageChecksum, ...checksumInput } = { ...auditPackage.manifest, files: manifestFiles }
  const manifest = { ...checksumInput, packageChecksum: digest(Buffer.from(canonicalJson(checksumInput), 'utf8')) }
  const authenticityPayload = canonicalJson({ format: manifest.format, version: manifest.version, tenantId: manifest.tenantId, purpose: manifest.purpose, packageChecksum: manifest.packageChecksum })
  return { ...auditPackage, files, manifest, ...(auditPackage.authenticity ? { authenticity: { ...auditPackage.authenticity, signature: authenticator.sign(authenticityPayload) } } : {}) }
}

describe('cycle 34 canonical dataset and fiscal chronology ordering', () => {
  it('produces identical bytes, checksums and signatures for arbitrarily ordered adapter rows', async () => {
    const original = source()
    const reversed = Object.fromEntries(Object.entries(original).map(([name, rows]) => [name, [...rows].reverse()])) as unknown as AuditExportSource
    const first = await createAuditPackage(original, access, { record: vi.fn() })
    const second = await createAuditPackage(reversed, access, { record: vi.fn() })
    expect(second).toEqual(first)
    expect(JSON.parse(first.files['data/masterData.json']).map((row: { id: string }) => row.id)).toEqual(['a-contact', 'z-company'])
    const migration = await createAuditPackage(original, { ...access, purpose: 'MIGRATION' }, { record: vi.fn() }, authenticator)
    expect(reconcileRoundTrip(original, importMigrationPackage(migration, tenantId, authenticator), tenantId).matches).toBe(true)
  })

  it('orders Grundbuch by authoritative fiscal chronology rather than opaque fiscal-year IDs', async () => {
    const grundbuch = (await createAuditPackage(source(), access, { record: vi.fn() })).files['reports/Grundbuch.csv']
    expect(grundbuch.indexOf('"z-old"')).toBeLessThan(grundbuch.indexOf('"a-new"'))
  })

  it('rejects fully rehashed dataset files whose bytes are not the canonical normalized representation', async () => {
    const migration = await createAuditPackage(source(), { ...access, purpose: 'MIGRATION' }, { record: vi.fn() }, authenticator)
    const path = 'data/masterData.json'
    const reversed = replaceAndRehashFile(migration, path, canonicalJson([...JSON.parse(migration.files[path])].reverse()))
    const pretty = replaceAndRehashFile(migration, path, JSON.stringify(JSON.parse(migration.files[path]), null, 2))

    for (const tampered of [reversed, pretty]) {
      expect(verifyAuditPackage(tampered)).toContain(`Dataset is not canonical or deterministically ordered: ${path}`)
      expect(() => importMigrationPackage(tampered, tenantId, authenticator)).toThrow(`Dataset is not canonical or deterministically ordered: ${path}`)
    }
  })
})
