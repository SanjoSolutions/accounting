import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { canonicalJson, createAuditPackage, verifyAuditPackage, type AuditExportSource, type AuditPackage } from './auditExport'

const tenantId = 'tenant-cycle-25'

function source(): AuditExportSource {
  return {
    masterData: [],
    chartMappings: [
      { tenantId, accountId: '1000', name: 'Cash' },
      { tenantId, accountId: '1200', name: 'Bank' },
    ],
    fiscalYears: [{ tenantId, id: '2026', startDate: '2026-01-01', endDate: '2026-12-31' }],
    journal: [],
    journalLines: [],
    openingClosing: [
      { tenantId, fiscalYearId: '2026', accountId: '1000', openingCents: 100, closingCents: 100 },
      { tenantId, fiscalYearId: '2026', accountId: '1200', openingCents: 200, closingCents: 200 },
    ],
    vatDetails: [],
    evidence: [],
    auditEvents: [],
    taxSubmissions: [],
    openItems: [],
  }
}

const access = {
  tenantId,
  actorId: 'auditor',
  authorityReference: 'AO-2026-25',
  accessedAt: '2026-07-18T12:00:00+02:00',
  purpose: 'AUDIT' as const,
}

async function packageForTest() {
  return createAuditPackage(source(), access, { record: vi.fn() })
}

function publiclyRehashManifest(auditPackage: AuditPackage, changes: Record<string, unknown>): AuditPackage {
  const changed = { ...auditPackage.manifest, ...changes }
  const { packageChecksum: _oldChecksum, ...checksumInput } = changed
  return {
    ...auditPackage,
    manifest: {
      ...changed,
      packageChecksum: createHash('sha256').update(canonicalJson(checksumInput)).digest('hex'),
    } as AuditPackage['manifest'],
  }
}

describe('cycle 25 audit export hardening', () => {
  it('exports multiple per-account opening/closing rows using the composite identity and declared account relationship', async () => {
    const auditPackage = await packageForTest()
    const schema = JSON.parse(auditPackage.files['documentation/schema.json'])

    expect(JSON.parse(auditPackage.files['data/openingClosing.json'])).toHaveLength(2)
    expect(schema.datasets.openingClosing.primaryKey).toEqual(['fiscalYearId', 'accountId'])
    expect(schema.relationships).toContain('openingClosing.accountId -> chartMappings.accountId')
    expect(verifyAuditPackage(auditPackage)).toEqual([])
  })

  it('rejects aggregate-only, duplicate-account, and unmapped-account opening/closing reconstruction', async () => {
    const aggregateOnly = source()
    aggregateOnly.openingClosing = [{ tenantId, fiscalYearId: '2026', openingCents: 300, closingCents: 375 }]
    await expect(createAuditPackage(aggregateOnly, access, { record: vi.fn() })).rejects.toThrow('openingClosing.accountId')

    const duplicateAccount = source()
    duplicateAccount.openingClosing = [...duplicateAccount.openingClosing, { ...duplicateAccount.openingClosing[0] }]
    await expect(createAuditPackage(duplicateAccount, access, { record: vi.fn() })).rejects.toThrow('openingClosing contains duplicate primary keys')

    const unmappedAccount = source()
    unmappedAccount.openingClosing = [{ ...unmappedAccount.openingClosing[0], accountId: '9999' }]
    await expect(createAuditPackage(unmappedAccount, access, { record: vi.fn() })).rejects.toThrow('opening/closing fiscal-year or account relationships')
  })

  it.each([
    [{ format: 'other-format' }, 'Manifest format is not supported'],
    [{ version: 2 }, 'Manifest version is not supported'],
    [{ tenantId: '   ' }, 'Manifest tenantId must be nonblank'],
    [{ createdAt: '2026-07-18T12:00:00' }, 'Manifest createdAt must be an ISO instant with an explicit offset'],
    [{ createdAt: '2026-02-30T12:00:00Z' }, 'Manifest createdAt must be an ISO instant with an explicit offset'],
    [{ purpose: 'RESTORE' }, 'Manifest purpose must be AUDIT or MIGRATION'],
    [{ authorityReference: '   ' }, 'Manifest authorityReference is required for AUDIT purpose'],
    [{ purpose: 'MIGRATION', authorityReference: '' }, 'Manifest authorityReference is required for MIGRATION purpose'],
  ])('rejects publicly rehashed top-level manifest semantics: %j', async (changes, expectedError) => {
    const malformed = publiclyRehashManifest(await packageForTest(), changes)

    expect(verifyAuditPackage(malformed)).toContain(expectedError)
    expect(verifyAuditPackage(malformed)).not.toContain('Package checksum mismatch')
  })
})
