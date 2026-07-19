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
})
