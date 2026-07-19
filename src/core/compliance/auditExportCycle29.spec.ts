import { describe, expect, it } from 'vitest'
import { verifyAuditPackage } from './auditExport'

const manifestFile = (path: string) => ({ path, bytes: 0, sha256: '0'.repeat(64) })

describe('cycle 29 audit package own-file lookup', () => {
  it('treats prototype names as missing unless they are own string-valued file entries', () => {
    for (const path of ['toString', '__proto__']) {
      const value = { manifest: { files: [manifestFile(path)] }, files: {} }
      expect(() => verifyAuditPackage(value)).not.toThrow()
      expect(verifyAuditPackage(value)).toContain(`Missing file: ${path}`)
    }
  })

  it('rejects inherited file-map values through the plain own-map contract', () => {
    const files = Object.create({ toString: 'inherited', '__proto__': 'inherited' }) as Record<string, string>
    const value = { manifest: { files: [manifestFile('toString')] }, files }
    expect(() => verifyAuditPackage(value)).not.toThrow()
    expect(verifyAuditPackage(value)).toContain('Audit package files must be an own plain object map')
  })
})
