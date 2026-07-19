import { describe, expect, it } from 'vitest'
import { importMigrationPackage, verifyAuditPackage } from './auditExport'

const inheritedManifestFields = { format: 'accounting-audit-package', version: 1, tenantId: 'tenant-cycle-33', createdAt: '2026-07-18T20:00:00Z', purpose: 'MIGRATION', authorityReference: 'AO-2026-33', files: [] }

describe('cycle 33 audit verifier own-property snapshot', () => {
  it('rejects manifest semantics inherited from a custom prototype even with an own checksum', () => {
    const manifest = Object.create(inheritedManifestFields) as Record<string, unknown>; manifest.packageChecksum = 'own-checksum'
    const value = { manifest, files: {} }
    expect(() => verifyAuditPackage(value)).not.toThrow()
    expect(verifyAuditPackage(value)).toContain('Audit package manifest must be an own plain object')
    expect(() => importMigrationPackage(value as never, 'tenant-cycle-33')).toThrow(/^Invalid audit package:/)
  })

  it('rejects inherited outer package and manifest-file-entry fields', () => {
    const inheritedPackage = Object.create({ manifest: { ...inheritedManifestFields, packageChecksum: 'x' }, files: {} })
    expect(verifyAuditPackage(inheritedPackage)).toContain('Audit package must be a plain object')
    const entry = Object.create({ path: 'documentation/README.txt', bytes: 0, sha256: '0'.repeat(64) })
    const value = { manifest: { ...inheritedManifestFields, files: [entry], packageChecksum: 'x' }, files: {} }
    expect(verifyAuditPackage(value)).toContain('Manifest file entry 0 must be a plain object')
  })
})
