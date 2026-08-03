import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('HGB account mapping presentation-sign migration', () => {
  it('persists an explicit constrained presentation sign for deterministic normalization', () => {
    const sql = readFileSync('prisma/migrations/20260803170000_hgb_mapping_presentation_sign/migration.sql', 'utf8')
    expect(sql).toContain('ADD COLUMN "presentationSign" INTEGER NOT NULL DEFAULT 1')
    expect(sql).toContain('NOT IN (-1, 1)')
  })
})
