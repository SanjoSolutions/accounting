import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

const temporaryDirectories: string[] = []
afterEach(() => temporaryDirectories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })))

describe('compliance foundations migration', () => {
  it('migrates a populated journal and represents unknown historic entry dates as null', () => {
    const directory = mkdtempSync(join(tmpdir(), 'accounting-compliance-migration-')); temporaryDirectories.push(directory)
    const database = new DatabaseSync(join(directory, 'migration.db'))
    const root = resolve(process.cwd(), 'prisma', 'migrations')
    const names = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
    for (const name of names.filter(name => name < '20260717210000_compliance_foundations')) database.exec(readFileSync(join(root, name, 'migration.sql'), 'utf8'))
    database.exec("INSERT INTO FiscalYear (id, ownerId, year, startsAt, endsAt, updatedAt) VALUES ('fy', 'owner', 2025, '2025-01-01', '2025-12-31', CURRENT_TIMESTAMP)")
    database.exec("INSERT INTO JournalEntry (id, sequenceNumber, bookingDate, documentNumber, description, fiscalYearId) VALUES ('entry', 1, '2025-01-02', 'D-1', 'historic', 'fy')")
    database.exec(readFileSync(join(root, '20260717210000_compliance_foundations', 'migration.sql'), 'utf8'))
    expect(database.prepare("SELECT state, entryDate FROM JournalEntry WHERE id = 'entry'").get()).toEqual({ state: 'POSTED', entryDate: null })
    database.close()
  })

  it('installs durable workflow tables and database-level immutable history guards', () => {
    const directory = mkdtempSync(join(tmpdir(), 'accounting-compliance-runtime-migration-')); temporaryDirectories.push(directory)
    const database = new DatabaseSync(join(directory, 'migration.db'))
    const root = resolve(process.cwd(), 'prisma', 'migrations')
    const names = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
    for (const name of names) database.exec(readFileSync(join(root, name, 'migration.sql'), 'utf8'))
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => (row as { name: string }).name)
    expect(tables).toEqual(expect.arrayContaining(['AuditHead', 'CompliancePolicy', 'CompanyProfileAddressConfirmation', 'JournalDraft', 'FilingAmendment']))
    expect(database.prepare("PRAGMA table_info('BackupManifest')").all().map(row => (row as { name: string }).name)).toContain('payloadStorageKey')
    expect(database.prepare("PRAGMA table_info('AuditEvent')").all().map(row => (row as { name: string }).name)).toContain('integrityKeyId')
    database.exec("INSERT INTO AuditEvent (id, ownerId, actorId, occurredAt, action, reason, objectType, objectId, semanticDelta, hash) VALUES ('a', 'owner', 'actor', CURRENT_TIMESTAMP, 'TEST', 'reason', 'Object', '1', '{}', 'hash')")
    expect(() => database.exec("UPDATE AuditEvent SET reason = 'tampered' WHERE id = 'a'")).toThrow(/append-only/)
    expect(() => database.exec("DELETE FROM AuditEvent WHERE id = 'a'")).toThrow(/append-only/)
    database.exec("INSERT INTO CompanyProfileVersion (id, ownerId, effectiveFrom, payload, createdBy, reason) VALUES ('p', 'owner', '2026-01-01', '{}', 'actor', 'initial')")
    expect(() => database.exec("UPDATE CompanyProfileVersion SET payload = '{\"changed\":true}' WHERE id = 'p'")).toThrow(/immutable/)
    database.exec("INSERT INTO CompanyProfileAddressConfirmation (id, ownerId, profileVersionId, payload, createdBy, reason) VALUES ('c', 'owner', 'p', '{}', 'actor', 'evidence')")
    expect(() => database.exec("UPDATE CompanyProfileAddressConfirmation SET payload = '{\"changed\":true}' WHERE id = 'c'")).toThrow(/immutable/)
    database.close()
  })

  it('fails closed instead of implicitly trusting unexpected pre-HMAC audit rows', () => {
    const directory = mkdtempSync(join(tmpdir(), 'accounting-audit-head-migration-')); temporaryDirectories.push(directory)
    const database = new DatabaseSync(join(directory, 'migration.db'))
    const root = resolve(process.cwd(), 'prisma', 'migrations')
    const names = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
    for (const name of names.filter(name => name < '20260719153000_foundation_runtime_integration')) database.exec(readFileSync(join(root, name, 'migration.sql'), 'utf8'))
    database.exec("INSERT INTO AuditEvent (id, ownerId, actorId, occurredAt, action, reason, objectType, objectId, semanticDelta, previousHash, hash) VALUES ('a1', 'owner', 'actor', '2026-01-01', 'A', 'r', 'Object', '1', '{}', NULL, 'hash-1'), ('a2', 'owner', 'actor', '2026-01-02', 'B', 'r', 'Object', '2', '{}', 'hash-1', 'hash-2')")
    expect(() => database.exec(readFileSync(join(root, '20260719153000_foundation_runtime_integration', 'migration.sql'), 'utf8'))).toThrow(/CHECK constraint/)
    expect(database.prepare("PRAGMA table_info('BackupManifest')").all().map(row => (row as { name: string }).name)).not.toContain('payloadStorageKey')
    database.close()
  })

  it('installs tenant-scoped reporting subledgers with immutable history guards', () => {
    const directory = mkdtempSync(join(tmpdir(), 'accounting-reporting-migration-')); temporaryDirectories.push(directory)
    const database = new DatabaseSync(join(directory, 'migration.db'))
    const root = resolve(process.cwd(), 'prisma', 'migrations')
    for (const name of readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()) database.exec(readFileSync(join(root, name, 'migration.sql'), 'utf8'))
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => (row as { name: string }).name)
    expect(tables).toEqual(expect.arrayContaining(['CompliancePackage', 'ProcedureDocumentRecord', 'FixedAssetRecord', 'AssetEventRecord', 'InventoryItemRecord', 'InventoryCountSnapshot', 'CashBookRecord', 'CashEntryRecord', 'CashCloseRecord']))
    database.exec("INSERT INTO ProcedureDocumentRecord (id, ownerId, documentId, version, effectiveFrom, payload, checksum, approvedBy, approvedAt) VALUES ('p', 'tenant-a', 'main', '1.0.0', '2026-01-01', '{}', 'hash', 'actor', '2026-01-01')")
    expect(() => database.exec("UPDATE ProcedureDocumentRecord SET payload = '{\"tampered\":true}' WHERE id = 'p'")).toThrow(/immutable/)
    database.exec("INSERT INTO CashEntryRecord (id, ownerId, cashBookId, sequence, businessDate, journalEntryId, payload) VALUES ('c', 'tenant-a', 'book', 1, '2026-01-01', 'journal', '{}')")
    expect(() => database.exec("DELETE FROM CashEntryRecord WHERE id = 'c'")).toThrow(/immutable/)
    database.exec("INSERT INTO CompliancePackage (id, ownerId, kind, fiscalPeriodId, version, status, payload, checksum, createdBy) VALUES ('a', 'tenant-a', 'ANNUAL_ACCOUNTS', 'fy', 1, 'CREATED', '{}', 'package-hash', 'actor')")
    database.exec("UPDATE CompliancePackage SET status = 'APPROVED', approvedBy = 'reviewer' WHERE id = 'a'")
    expect(() => database.exec("UPDATE CompliancePackage SET payload = '{\"tampered\":true}' WHERE id = 'a'")).toThrow(/immutable/)
    database.close()
  }, 15_000)

  it('installs immutable E-Bilanz taxonomy, reconciliation, and report-version evidence', () => {
    const directory = mkdtempSync(join(tmpdir(), 'accounting-e-bilanz-lifecycle-migration-')); temporaryDirectories.push(directory)
    const database = new DatabaseSync(join(directory, 'migration.db')); const root = resolve(process.cwd(), 'prisma', 'migrations')
    for (const name of readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()) database.exec(readFileSync(join(root, name, 'migration.sql'), 'utf8'))
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => (row as { name: string }).name)
    expect(tables).toEqual(expect.arrayContaining(['EBalanceTaxonomyRelease', 'EBalanceLifecycleReport', 'EBalanceReconciliationRecord']))
    database.exec("INSERT INTO EBalanceTaxonomyRelease (version, validFrom, validThrough, gaapNamespace, gcdNamespace, entryPoint, archiveSha256, archiveStorageKey, compatibility, registeredBy) VALUES ('6.10', '2026-01-01', '2026-12-31', 'gaap', 'gcd', 'entry.xsd', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'taxonomy.zip', '{}', 'admin')")
    expect(() => database.exec("UPDATE EBalanceTaxonomyRelease SET entryPoint = 'tampered.xsd' WHERE version = '6.10'")).toThrow(/immutable/)
    database.exec("INSERT INTO EBalanceReconciliationRecord (id, ownerId, fiscalYearId, kind, payload, checksum, evidenceIds, approvedBy, approvedAt) VALUES ('r', 'tenant', 'fy', 'ADJUSTMENT', '{}', 'hash', '[\"e\"]', 'actor', '2026-12-31')")
    database.exec("INSERT INTO EBalanceReconciliationRecord (id, ownerId, fiscalYearId, kind, payload, checksum, evidenceIds, approvedBy, approvedAt) VALUES ('r-next-year', 'tenant', 'fy-next', 'ADJUSTMENT', '{}', 'hash', '[\"e\"]', 'actor', '2027-12-31')")
    database.exec("INSERT INTO EBalanceReconciliationRecord (id, ownerId, fiscalYearId, kind, payload, checksum, evidenceIds, approvedBy, approvedAt) VALUES ('r-special', 'tenant', 'fy', 'SPECIAL_BALANCE', '{}', 'hash', '[\"e\"]', 'actor', '2026-12-31')")
    expect(() => database.exec("INSERT INTO EBalanceReconciliationRecord (id, ownerId, fiscalYearId, kind, payload, checksum, evidenceIds, approvedBy, approvedAt) VALUES ('r-duplicate', 'tenant', 'fy', 'ADJUSTMENT', '{}', 'hash', '[\"e\"]', 'actor', '2026-12-31')")).toThrow(/UNIQUE constraint/)
    expect(() => database.exec("DELETE FROM EBalanceReconciliationRecord WHERE id = 'r'")).toThrow(/immutable/)
    database.close()
  })
})
