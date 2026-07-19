import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { canonicalJson, createAuditPackage, importMigrationPackage, reconcileRoundTrip, verifyAuditPackage, type AuditExportSource, type MigrationPackageAuthenticator } from './auditExport'

const tenantId = 'tenant-cycle-30'
const access = { tenantId, actorId: 'auditor', authorityReference: 'AO-2026-30', accessedAt: '2026-07-18T17:00:00Z', purpose: 'AUDIT' as const }
const source = (tags: unknown): AuditExportSource => ({ masterData: [{ tenantId, id: 'company', tags }], chartMappings: [], fiscalYears: [], journal: [], journalLines: [], openingClosing: [], vatDetails: [], evidence: [], auditEvents: [], taxSubmissions: [], openItems: [] })
const authenticator: MigrationPackageAuthenticator = { keyId: 'cycle-30-test-anchor', sign: payload => createHash('sha256').update(`anchor:${payload}`).digest('hex'), verify(payload, signature, keyId) { return keyId === this.keyId && signature === this.sign(payload) } }

describe('cycle 30 canonical arrays and invalid audit instants', () => {
  it('rejects sparse arrays at the root and every nested serialization level', async () => {
    const rootHole = Array(1)
    const nestedHole = Array(2); nestedHole[0] = 'tag'
    expect(() => canonicalJson(rootHole)).toThrow('sparse arrays')
    expect(() => canonicalJson({ one: [{ two: nestedHole }] })).toThrow('sparse arrays')
    await expect(createAuditPackage({ ...source([]), masterData: Array(1) }, access, { record: vi.fn() })).rejects.toThrow('sparse arrays')
    await expect(createAuditPackage(source([['dense'], { deeper: Array(1) }]), access, { record: vi.fn() })).rejects.toThrow('sparse arrays')
  })

  it('preserves dense nested arrays byte-for-byte through migration round-trip', async () => {
    const original = source([['first', 'second'], { deeper: [1, null, 3] }])
    const migration = await createAuditPackage(original, { ...access, purpose: 'MIGRATION' }, { record: vi.fn() }, authenticator)
    const restored = importMigrationPackage(migration, tenantId, authenticator)
    expect(reconcileRoundTrip(original, restored, tenantId).matches).toBe(true)
  })

  it('generates reports from canonical runtime values without double-escaping tags', async () => {
    const original = { ...source([]), openItems: [{ tenantId, id: 'open-1', outstandingCents: 100, dueAt: new Date('2026-08-01T00:00:00Z'), attachment: new Uint8Array([1, 2]), applicationData: { $type: 'Date', $value: 'not-a-tag' } }] }
    const migration = await createAuditPackage(original, { ...access, purpose: 'MIGRATION' }, { record: vi.fn() }, authenticator)
    expect(verifyAuditPackage(migration)).toEqual([])
    const restored = importMigrationPackage(migration, tenantId, authenticator)
    expect(reconcileRoundTrip(original, restored, tenantId).matches).toBe(true)
  })

  it('returns declared validation errors for impossible manifest dates without throwing RangeError', () => {
    for (const createdAt of ['2026-99-99T00:00:00Z', '2026-02-30T00:00:00Z']) {
      const malformed = { manifest: { format: 'accounting-audit-package', version: 1, tenantId, createdAt, purpose: 'MIGRATION', authorityReference: 'AO-30', files: [], packageChecksum: 'invalid' }, files: {} }
      expect(() => verifyAuditPackage(malformed)).not.toThrow()
      expect(verifyAuditPackage(malformed)).toContain('Manifest createdAt must be an ISO instant with an explicit offset')
      expect(() => importMigrationPackage(malformed as never, tenantId, authenticator)).toThrow('trusted external anchor')
    }
  })
})
