import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('HGB workpaper persistence migration', () => {
  it('stores tenant-scoped versioned workpapers and idempotent adjustment posting links', async () => {
    const sql = await readFile(new URL('../../prisma/migrations/20260803160000_hgb_workpapers/migration.sql', import.meta.url), 'utf8')
    expect(sql).toContain('CREATE TABLE "HgbWorkpaperRecord"')
    expect(sql).toContain('"ownerId" TEXT NOT NULL')
    expect(sql).toContain('"version" INTEGER NOT NULL')
    expect(sql).toContain('"checksum" TEXT NOT NULL')
    expect(sql).toContain('HgbWorkpaperRecord_ownerId_fiscalPeriodId_kind_version_key')
    expect(sql).toContain('CREATE TABLE "HgbAdjustmentRecord"')
    expect(sql).toContain('"fingerprint" TEXT NOT NULL')
    expect(sql).toContain('"idempotencyKey" TEXT')
    expect(sql).toContain('"postedEntryId" TEXT')
    expect(sql).toContain('HgbAdjustmentRecord_ownerId_idempotencyKey_key')
  })
})
