import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createAuditPackage, type AuditExportSource } from './auditExport'

const tenantId = 'tenant-cycle-26'
const access = { tenantId, actorId: 'auditor', authorityReference: 'AO-2026-26', accessedAt: '2026-07-18T12:00:00+02:00', purpose: 'AUDIT' as const }

function source(): AuditExportSource {
  return {
    masterData: [],
    chartMappings: [
      { tenantId, accountId: '1000', name: 'Cash' },
      { tenantId, accountId: '2000', name: 'Equity' },
    ],
    fiscalYears: [
      { tenantId, id: 'FY-2025', startDate: '2025-01-01', endDate: '2025-12-31' },
      { tenantId, id: 'FY-2026', startDate: '2026-01-01', endDate: '2026-12-31' },
    ],
    journal: [
      { tenantId, id: 'j-2025', fiscalYearId: 'FY-2025', sequenceNumber: 1, bookingDate: '2025-06-30', documentNumber: 'D-25', description: '2025 posting' },
      { tenantId, id: 'j-2026', fiscalYearId: 'FY-2026', sequenceNumber: 1, bookingDate: '2026-06-30', documentNumber: 'D-26', description: '2026 posting' },
    ],
    journalLines: [
      { tenantId, id: 'l-25-d', journalEntryId: 'j-2025', accountId: '1000', debitCents: 50, creditCents: 0 },
      { tenantId, id: 'l-25-c', journalEntryId: 'j-2025', accountId: '2000', debitCents: 0, creditCents: 50 },
      { tenantId, id: 'l-26-d', journalEntryId: 'j-2026', accountId: '1000', debitCents: 20, creditCents: 0 },
      { tenantId, id: 'l-26-c', journalEntryId: 'j-2026', accountId: '2000', debitCents: 0, creditCents: 20 },
    ],
    openingClosing: [
      { tenantId, fiscalYearId: 'FY-2025', accountId: '1000', openingCents: 100, closingCents: 150 },
      { tenantId, fiscalYearId: 'FY-2025', accountId: '2000', openingCents: -100, closingCents: -150 },
      { tenantId, fiscalYearId: 'FY-2026', accountId: '1000', openingCents: 150, closingCents: 170 },
      { tenantId, fiscalYearId: 'FY-2026', accountId: '2000', openingCents: -150, closingCents: -170 },
    ],
    vatDetails: [], evidence: [], auditEvents: [], taxSubmissions: [], openItems: [],
  }
}

describe('cycle 26 audit export fiscal-period reports and access hardening', () => {
  it('starts each account sheet at its period opening and keeps Hauptbuch, SuSa and drilldown balances period-specific and reconciled', async () => {
    const auditPackage = await createAuditPackage(source(), access, { record: vi.fn() })
    const hauptbuch = auditPackage.files['reports/Hauptbuch-Kontenblaetter.csv']
    const susa = auditPackage.files['reports/SuSa.csv']
    const drilldown = JSON.parse(auditPackage.files['reports/statement-drilldown.json']) as { accounts: Record<string, unknown>[] }

    expect(hauptbuch).toContain('fiscalYearId;account;accountName;rowType')
    expect(hauptbuch).toContain('balanceCents;calculatedClosingCents;declaredClosingCents;closingDifferenceCents;reconciled')
    expect(hauptbuch).toContain('"FY-2025";"1000";"Cash";"OPENING"')
    expect(hauptbuch).toContain('"FY-2025";"1000";"Cash";"POSTING";"1";"2025-06-30";"D-25";"2025 posting";"100";"50";"0";"150"')
    expect(hauptbuch).toContain('"FY-2026";"1000";"Cash";"POSTING";"1";"2026-06-30";"D-26";"2026 posting";"150";"20";"0";"170"')
    expect(hauptbuch).toContain('"FY-2025";"1000";"Cash";"CLOSING";"";"2025-12-31";"";"Closing balance reconciliation";"100";"50";"0";"150";"150";"150";"0";"true"')
    expect(hauptbuch).toContain('"FY-2026";"1000";"Cash";"CLOSING";"";"2026-12-31";"";"Closing balance reconciliation";"150";"20";"0";"170";"170";"170";"0";"true"')
    expect(susa).toContain('"FY-2025";"2025-01-01";"2025-12-31";"1000";"Cash";"100";"50";"0";"150";"150";"true"')
    expect(susa).toContain('"FY-2026";"2026-01-01";"2026-12-31";"1000";"Cash";"150";"20";"0";"170";"170";"true"')
    expect(drilldown.accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ fiscalYearId: 'FY-2025', accountId: '1000', openingCents: 100, debitCents: 50, calculatedClosingCents: 150, declaredClosingCents: 150, reconciled: true, journalLineIds: ['l-25-d'] }),
      expect.objectContaining({ fiscalYearId: 'FY-2026', accountId: '1000', openingCents: 150, debitCents: 20, calculatedClosingCents: 170, declaredClosingCents: 170, reconciled: true, journalLineIds: ['l-26-d'] }),
    ]))
    expect(auditPackage.files['reports/Grundbuch.csv']).toContain('"FY-2025";"1";"2025-06-30"')
    expect(auditPackage.files['reports/Grundbuch.csv']).toContain('"FY-2026";"1";"2026-06-30"')
  })

  it('requires an opening/closing row for every mapped account in every authoritative fiscal year and reconciles it', async () => {
    const missing = source(); missing.openingClosing = missing.openingClosing.filter(row => !(row.fiscalYearId === 'FY-2026' && row.accountId === '2000'))
    await expect(createAuditPackage(missing, access, { record: vi.fn() })).rejects.toThrow('openingClosing is missing account 2000 for fiscal year FY-2026')

    const unreconciled = source(); unreconciled.openingClosing = unreconciled.openingClosing.map(row => row.fiscalYearId === 'FY-2025' && row.accountId === '1000' ? { ...row, closingCents: 149 } : row)
    await expect(createAuditPackage(unreconciled, access, { record: vi.fn() })).rejects.toThrow('does not reconcile for account 1000 in fiscal year FY-2025')
  })

  it('requires journals to reference an authoritative fiscal year whose period contains the booking date', async () => {
    const unknown = source(); unknown.journal = unknown.journal.map(row => row.id === 'j-2026' ? { ...row, fiscalYearId: 'unknown' } : row)
    await expect(createAuditPackage(unknown, access, { record: vi.fn() })).rejects.toThrow('journal fiscal-year relationships or booking periods')

    const outside = source(); outside.journal = outside.journal.map(row => row.id === 'j-2026' ? { ...row, bookingDate: '2025-12-31' } : row)
    await expect(createAuditPackage(outside, access, { record: vi.fn() })).rejects.toThrow('journal fiscal-year relationships or booking periods')
  })

  it('rejects a blank export tenant before tenant filtering or audit logging', async () => {
    const sink = { record: vi.fn() }
    await expect(createAuditPackage(source(), { ...access, tenantId: '   ' }, sink)).rejects.toThrow('Export tenantId is required')
    expect(sink.record).not.toHaveBeenCalled()
  })

  it('compares evidence SHA-256 values case-insensitively after normalization', async () => {
    const evidenceBytes = new Uint8Array([1, 2, 3]); const uppercaseDigest = createHash('sha256').update(evidenceBytes).digest('hex').toUpperCase()
    const withUppercaseDigest = source(); withUppercaseDigest.evidence = [{ tenantId, id: 'e-1', journalEntryId: 'j-2026', fileName: 'evidence.bin', mediaType: 'application/octet-stream', bytes: evidenceBytes, sizeBytes: evidenceBytes.byteLength, sha256: uppercaseDigest }]
    await expect(createAuditPackage(withUppercaseDigest, access, { record: vi.fn() })).resolves.toBeDefined()
  })

  it('keeps negative numeric balances numeric while neutralizing formula-like strings', async () => {
    const formula = source(); formula.chartMappings = formula.chartMappings.map(row => row.accountId === '2000' ? { ...row, name: '-2+3' } : row)
    const auditPackage = await createAuditPackage(formula, access, { record: vi.fn() })
    const hauptbuch = auditPackage.files['reports/Hauptbuch-Kontenblaetter.csv']
    const susa = auditPackage.files['reports/SuSa.csv']

    expect(hauptbuch).toContain('"FY-2025";"2000";"\'-2+3";"OPENING";"";"2025-01-01";"";"Opening balance";"-100";"0";"0";"-100"')
    expect(susa).toContain('"FY-2025";"2025-01-01";"2025-12-31";"2000";"\'-2+3";"-100";"0";"50";"-150";"-150";"true"')
    expect(hauptbuch).not.toContain('"\'-100"')
    expect(susa).not.toContain('"\'-150"')
  })
})
