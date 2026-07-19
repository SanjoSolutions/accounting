import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { canonicalJson, createAuditPackage, importMigrationPackage, verifyAuditPackage, type AuditExportSource, type AuditPackage } from './auditExport'

const tenantId = 'tenant-cycle-28'
const access = { tenantId, actorId: 'auditor', authorityReference: 'AO-2026-28', accessedAt: '2026-07-18T16:00:00Z', purpose: 'AUDIT' as const }

function source(): AuditExportSource {
  return {
    masterData: [],
    chartMappings: [{ tenantId, accountId: '1000', name: 'Cash' }, { tenantId, accountId: '2000', name: 'Revenue' }],
    fiscalYears: [{ tenantId, id: 'FY-2026', startDate: '2026-01-01', endDate: '2026-12-31' }],
    journal: [{ tenantId, id: 'j-1', fiscalYearId: 'FY-2026', sequenceNumber: 1, bookingDate: '2026-06-30', documentNumber: 'D-1', description: 'Sale' }],
    journalLines: [{ tenantId, id: 'l-1', journalEntryId: 'j-1', accountId: '1000', debitCents: 100, creditCents: 0 }, { tenantId, id: 'l-2', journalEntryId: 'j-1', accountId: '2000', debitCents: 0, creditCents: 100 }],
    openingClosing: [{ tenantId, fiscalYearId: 'FY-2026', accountId: '1000', openingCents: 50, closingCents: 150 }, { tenantId, fiscalYearId: 'FY-2026', accountId: '2000', openingCents: -50, closingCents: -150 }],
    vatDetails: [], evidence: [], auditEvents: [], taxSubmissions: [], openItems: [],
  }
}

function rehashFile(auditPackage: AuditPackage, path: string, contents: string): AuditPackage {
  const files = { ...auditPackage.files, [path]: contents }
  const manifestFiles = auditPackage.manifest.files.map(file => file.path === path ? { ...file, bytes: Buffer.byteLength(contents), sha256: createHash('sha256').update(contents).digest('hex'), ...(path.startsWith('data/') ? { rows: Array.isArray(JSON.parse(contents)) ? JSON.parse(contents).length : 0 } : {}) } : file)
  const { packageChecksum: _old, ...checksumInput } = { ...auditPackage.manifest, files: manifestFiles }
  return { ...auditPackage, files, manifest: { ...checksumInput, files: manifestFiles, packageChecksum: createHash('sha256').update(canonicalJson(checksumInput)).digest('hex') } }
}

describe('cycle 28 audit package semantic and structural verification', () => {
  it('runs full relationship and reconciliation validation for audit-purpose packages', async () => {
    const auditPackage = await createAuditPackage(source(), access, { record: vi.fn() })
    const orphaned = rehashFile(auditPackage, 'data/journal.json', '[]')
    expect(verifyAuditPackage(orphaned)).toEqual(expect.arrayContaining([expect.stringContaining('journal-line relationships')]))

    const unreconciledRows = source().openingClosing.map(row => row.accountId === '1000' ? { ...row, closingCents: 149 } : row)
    const unreconciled = rehashFile(auditPackage, 'data/openingClosing.json', canonicalJson(unreconciledRows))
    expect(verifyAuditPackage(unreconciled)).toEqual(expect.arrayContaining([expect.stringContaining('does not reconcile')]))
  })

  it('reproduces standard reports from verified datasets and rejects a rehashed stale report', async () => {
    const auditPackage = await createAuditPackage(source(), access, { record: vi.fn() })
    const forgedReport = rehashFile(auditPackage, 'reports/SuSa.csv', `${auditPackage.files['reports/SuSa.csv']}forged`)
    expect(verifyAuditPackage(forgedReport)).toContain('Report does not match datasets: reports/SuSa.csv')
  })

  it('returns controlled structural errors for malformed untrusted package shapes', () => {
    const malformed: unknown[] = [null, [], {}, { manifest: null, files: {} }, { manifest: { files: null }, files: {} }, { manifest: { files: [null] }, files: {} }, { manifest: { files: [{ path: 1, bytes: '1', sha256: 1 }] }, files: {} }, { manifest: { files: [] }, files: { x: 1 } }]
    for (const value of malformed) {
      expect(() => verifyAuditPackage(value)).not.toThrow()
      expect(verifyAuditPackage(value).length).toBeGreaterThan(0)
    }
  })

  it('makes migration import reject malformed shapes as invalid packages rather than throwing traversal TypeErrors', () => {
    for (const value of [null, {}, { manifest: { files: [] }, files: null }]) expect(() => importMigrationPackage(value as never, tenantId)).toThrow(/^Invalid audit package:/)
  })
})
