import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('HGB close run migration', () => {
  it('enforces immutable versioned run history in the database', () => {
    const database = new DatabaseSync(':memory:')
    database.exec('PRAGMA foreign_keys = ON')
    database.exec('CREATE TABLE "FiscalYear" ("id" TEXT NOT NULL PRIMARY KEY)')
    database.exec(readFileSync(join(process.cwd(), 'prisma/migrations/20260803150000_hgb_close_runs/migration.sql'), 'utf8'))
    database.prepare('INSERT INTO "FiscalYear" ("id") VALUES (?)').run('fy-2026')
    database.prepare('INSERT INTO "HgbCloseRun" ("id", "ownerId", "fiscalPeriodId", "version", "status", "ruleSetVersion", "ledgerFingerprint", "inputChecksum", "checksum", "payload", "createdBy") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('run-1', 'tenant-a', 'fy-2026', 1, 'BLOCKED', 'HGB-DE-2024.1', 'ledger', 'input', 'checksum', '{}', 'actor-a')

    expect(() => database.prepare('UPDATE "HgbCloseRun" SET "status" = ? WHERE "id" = ?').run('READY_TO_LOCK', 'run-1')).toThrow(/immutable/)
    expect(() => database.prepare('DELETE FROM "HgbCloseRun" WHERE "id" = ?').run('run-1')).toThrow(/immutable/)
    expect(() => database.prepare('INSERT INTO "HgbCloseRun" ("id", "ownerId", "fiscalPeriodId", "version", "status", "ruleSetVersion", "ledgerFingerprint", "inputChecksum", "checksum", "payload", "createdBy") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('run-2', 'tenant-a', 'fy-2026', 1, 'BLOCKED', 'HGB-DE-2024.1', 'other', 'other', 'other', '{}', 'actor-a')).toThrow(/UNIQUE/)
    database.close()
  })
})
