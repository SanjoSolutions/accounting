import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('fiscal close generation migration', () => {
  it('binds E-Bilanz records to immutable exact close generations', () => {
    const database = new DatabaseSync(':memory:')
    database.exec('PRAGMA foreign_keys = ON')
    database.exec(`
      CREATE TABLE "FiscalYear" ("id" TEXT NOT NULL PRIMARY KEY);
      CREATE TABLE "HgbCloseRun" ("id" TEXT NOT NULL PRIMARY KEY);
      CREATE TABLE "EBalanceSubmission" (
        "id" TEXT NOT NULL PRIMARY KEY, "ownerId" TEXT NOT NULL, "year" INTEGER NOT NULL,
        "fiscalYearId" TEXT NOT NULL, "kind" TEXT NOT NULL, "idempotencyKey" TEXT NOT NULL,
        "payloadHash" TEXT NOT NULL, "requestHash" TEXT NOT NULL, "requestXml" TEXT NOT NULL
      );
      CREATE TABLE "EBalanceLifecycleReport" (
        "id" TEXT NOT NULL PRIMARY KEY, "ownerId" TEXT NOT NULL, "fiscalYearId" TEXT NOT NULL,
        "version" INTEGER NOT NULL, "taxonomyVersion" TEXT NOT NULL, "profileSnapshot" TEXT NOT NULL,
        "reportPayload" TEXT NOT NULL, "reportXml" TEXT NOT NULL, "reportChecksum" TEXT NOT NULL,
        "storageKey" TEXT NOT NULL, "supersedesId" TEXT
      );
      CREATE UNIQUE INDEX "EBalanceLifecycleReport_ownerId_reportChecksum_key" ON "EBalanceLifecycleReport"("ownerId", "reportChecksum");
      CREATE TRIGGER "EBalanceLifecycleReport_payload_immutable" BEFORE UPDATE ON "EBalanceLifecycleReport"
      BEGIN SELECT RAISE(ABORT, 'old trigger'); END;
    `)
    database.exec(readFileSync(join(process.cwd(), 'prisma/migrations/20260803180000_fiscal_close_generations/migration.sql'), 'utf8'))
    database.prepare('INSERT INTO "FiscalYear" ("id") VALUES (?)').run('fy-2025')
    database.prepare('INSERT INTO "HgbCloseRun" ("id") VALUES (?)').run('hgb-1')
    database.prepare('INSERT INTO "FiscalCloseGeneration" ("id", "ownerId", "fiscalYearId", "generation", "hgbCloseRunId", "hgbCloseRunChecksum", "snapshotHash", "lockedAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('close-1', 'tenant-a', 'fy-2025', 1, 'hgb-1', 'hgb-hash', 'snapshot-hash', '2026-01-31T12:00:00.000Z')
    database.prepare('INSERT INTO "FiscalCloseGeneration" ("id", "ownerId", "fiscalYearId", "generation", "hgbCloseRunId", "hgbCloseRunChecksum", "snapshotHash", "lockedAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('close-2', 'tenant-a', 'fy-2025', 2, 'hgb-1', 'hgb-hash', 'snapshot-hash-2', '2026-02-28T12:00:00.000Z')
    database.prepare('INSERT INTO "EBalanceSubmission" ("id", "ownerId", "year", "fiscalYearId", "kind", "idempotencyKey", "payloadHash", "requestHash", "requestXml", "closeGenerationId") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('submission-1', 'tenant-a', 2025, 'fy-2025', 'SUBMISSION', 'key-1', 'payload', 'request', '<xml/>', 'close-1')

    expect(() => database.prepare('UPDATE "FiscalCloseGeneration" SET "snapshotHash" = ? WHERE "id" = ?').run('changed', 'close-1')).toThrow(/immutable/)
    expect(() => database.prepare('DELETE FROM "FiscalCloseGeneration" WHERE "id" = ?').run('close-1')).toThrow(/immutable/)
    expect(() => database.prepare('UPDATE "EBalanceSubmission" SET "closeGenerationId" = NULL WHERE "id" = ?').run('submission-1')).toThrow(/immutable/)
    expect(() => database.prepare('INSERT INTO "EBalanceSubmission" ("id", "ownerId", "year", "fiscalYearId", "kind", "idempotencyKey", "payloadHash", "requestHash", "requestXml", "closeGenerationId") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('submission-2', 'tenant-a', 2025, 'fy-2025', 'SUBMISSION', 'key-2', 'payload', 'request', '<xml/>', 'missing')).toThrow(/FOREIGN KEY/)
    const insertReport = database.prepare('INSERT INTO "EBalanceLifecycleReport" ("id","ownerId","fiscalYearId","closeGenerationId","version","taxonomyVersion","profileSnapshot","reportPayload","reportXml","reportChecksum","storageKey") VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    insertReport.run('report-1', 'tenant-a', 'fy-2025', 'close-1', 1, '6.9', '{}', '{}', '<xbrl/>', 'same-report-hash', 'report-1.xml')
    insertReport.run('report-2', 'tenant-a', 'fy-2025', 'close-2', 2, '6.9', '{}', '{}', '<xbrl/>', 'same-report-hash', 'report-2.xml')
    expect(database.prepare('SELECT COUNT(*) AS count FROM "EBalanceLifecycleReport" WHERE "reportChecksum" = ?').get('same-report-hash')).toEqual({ count: 2 })
    database.close()
  })
})
