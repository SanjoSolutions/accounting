import { describe, expect, test, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { verifySnapshotInIsolatedDatabase } from './restoreVerification'
import { tenantBackupRegistry, TENANT_BACKUP_SCHEMA_VERSION } from './tenantBackupRegistry'

const snapshot = () => ({
  ...Object.fromEntries(tenantBackupRegistry.map(definition => [definition.snapshotKey, definition.shape === 'singleton' ? null : []])),
  schemaVersion: TENANT_BACKUP_SCHEMA_VERSION, ownerId: 'euer-owner', audit: [], auditHead: null,
  periods: [{ id: 'year', ownerId: 'euer-owner', year: 2026, startsAt: '2026-01-01', endsAt: '2026-12-31', status: 'LOCKED', updatedAt: '2026-12-31' }],
  euerRevisions: [{ id: 'euer', ownerId: 'euer-owner', year: 2026, version: 1, requestKey: 'synthetic-request', requestHash: 'hash', profileChecksum: 'profile-hash', payload: '{}', createdBy: 'accountant' }],
})
describe('EÜR backup compatibility', () => {
  test('Given a locked-year EÜR revision, when restoring a tenant backup, then immutable historical workpapers remain restorable', () => {
    expect(() => verifySnapshotInIsolatedDatabase(snapshot())).not.toThrow()
  })
  test('Given an older v4 backup, when its absent EÜR collection is upgraded, then historical recovery remains supported', () => {
    const value: Record<string, any> = snapshot(); value.schemaVersion = 4; delete value.euerRevisions
    expect(() => verifySnapshotInIsolatedDatabase(value as any)).not.toThrow()
  })
  test('Given a current backup missing EÜR evidence or crossing tenant scope, when verified, then recovery fails closed', () => {
    const missing: Record<string, any> = snapshot(); delete missing.euerRevisions
    expect(() => verifySnapshotInIsolatedDatabase(missing as any)).toThrow(/euerRevisions is missing/)
    const crossTenant = snapshot(); crossTenant.euerRevisions[0].ownerId = 'other'
    expect(() => verifySnapshotInIsolatedDatabase(crossTenant)).toThrow(/euerRevisions crosses tenant scope/)
  })
})
