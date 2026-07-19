import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { canonicalJson, createAuditPackage, verifyAuditPackage, type AuditExportSource, type AuditPackage } from './auditExport'

const tenantId = 'tenant-cycle-32'
const access = { tenantId, actorId: 'auditor', authorityReference: 'AO-2026-32', accessedAt: '2026-07-18T19:00:00Z', purpose: 'AUDIT' as const }

function source(): AuditExportSource {
  return {
    masterData: [], chartMappings: [{ tenantId, accountId: '1000', name: 'Cash' }, { tenantId, accountId: '8000', name: 'Revenue' }],
    fiscalYears: [{ tenantId, id: 'FY-2025', startDate: '2025-01-01', endDate: '2025-12-31' }, { tenantId, id: 'FY-2026', startDate: '2026-01-01', endDate: '2026-12-31' }],
    journal: [{ tenantId, id: 'j-1', fiscalYearId: 'FY-2025', sequenceNumber: 1, bookingDate: '2025-06-30', documentNumber: 'D-1', description: 'Sale' }],
    journalLines: [{ tenantId, id: 'l-1', journalEntryId: 'j-1', accountId: '1000', debitCents: 119, creditCents: 0 }, { tenantId, id: 'l-2', journalEntryId: 'j-1', accountId: '8000', debitCents: 0, creditCents: 119 }],
    openingClosing: [{ tenantId, fiscalYearId: 'FY-2025', accountId: '1000', openingCents: 0, closingCents: 119 }, { tenantId, fiscalYearId: 'FY-2025', accountId: '8000', openingCents: 0, closingCents: -119 }, { tenantId, fiscalYearId: 'FY-2026', accountId: '1000', openingCents: 119, closingCents: 119 }, { tenantId, fiscalYearId: 'FY-2026', accountId: '8000', openingCents: -119, closingCents: -119 }],
    vatDetails: [{ tenantId, id: 'vat-1', journalLineId: 'l-1', taxCode: 'U19', baseCents: 100, taxAmountCents: 19, returnPeriod: '2025-06', submissionId: 'sub-1' }],
    evidence: [], auditEvents: [], taxSubmissions: [{ tenantId, id: 'sub-1', fiscalYearId: 'FY-2025', kind: 'VAT', returnPeriod: '2025-06', status: 'ACCEPTED' }], openItems: [],
  }
}

function rehashFile(auditPackage: AuditPackage, path: string, contents: string): AuditPackage {
  const files = { ...auditPackage.files, [path]: contents }
  const manifestFiles = auditPackage.manifest.files.map(file => file.path === path ? { ...file, bytes: Buffer.byteLength(contents), sha256: createHash('sha256').update(contents).digest('hex'), ...(path.startsWith('data/') ? { rows: (JSON.parse(contents) as unknown[]).length } : {}) } : file)
  const { packageChecksum: _old, ...checksumInput } = { ...auditPackage.manifest, files: manifestFiles }
  return { ...auditPackage, files, manifest: { ...checksumInput, files: manifestFiles, packageChecksum: createHash('sha256').update(canonicalJson(checksumInput)).digest('hex') } }
}

describe('cycle 32 VAT linkage and reproducible documentation', () => {
  it('requires VAT details to link to a VAT submission in the journal fiscal year before sealing', async () => {
    const wrongKind = source(); wrongKind.taxSubmissions = wrongKind.taxSubmissions.map(row => ({ ...row, kind: 'INCOME_TAX' }))
    await expect(createAuditPackage(wrongKind, access, { record: vi.fn() })).rejects.toThrow('VAT submission kind or fiscal-year linkage')
    const wrongYear = source(); wrongYear.taxSubmissions = wrongYear.taxSubmissions.map(row => ({ ...row, fiscalYearId: 'FY-2026' }))
    await expect(createAuditPackage(wrongYear, access, { record: vi.fn() })).rejects.toThrow('VAT submission kind or fiscal-year linkage')
  })

  it('semantically rejects rehashed non-VAT and cross-year submission links during verification', async () => {
    const auditPackage = await createAuditPackage(source(), access, { record: vi.fn() })
    for (const patch of [{ kind: 'INCOME_TAX' }, { fiscalYearId: 'FY-2026' }]) {
      const submissions = source().taxSubmissions.map(row => ({ ...row, ...patch }))
      expect(verifyAuditPackage(rehashFile(auditPackage, 'data/taxSubmissions.json', canonicalJson(submissions)))).toEqual(expect.arrayContaining([expect.stringContaining('VAT submission kind or fiscal-year linkage')]))
    }
  })

  it('regenerates README and schema documentation and rejects rehashed tampering', async () => {
    const auditPackage = await createAuditPackage(source(), access, { record: vi.fn() })
    const readme = rehashFile(auditPackage, 'documentation/README.txt', `${auditPackage.files['documentation/README.txt']}tampered\n`)
    expect(verifyAuditPackage(readme)).toContain('Documentation does not match datasets/contracts: documentation/README.txt')
    const schema = rehashFile(auditPackage, 'documentation/schema.json', '{}')
    expect(verifyAuditPackage(schema)).toContain('Documentation does not match datasets/contracts: documentation/schema.json')
  })
})
