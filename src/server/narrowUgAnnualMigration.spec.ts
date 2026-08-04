import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('narrow UG/GmbH annual-tax migrations', () => {
  it('persists immutable fail-closed facts and exact-close dataset bindings', () => {
    const database = new DatabaseSync(':memory:'); database.exec('PRAGMA foreign_keys = ON')
    database.exec(`
      CREATE TABLE "FiscalCloseGeneration" ("id" TEXT NOT NULL PRIMARY KEY);
      CREATE TABLE "TaxDatasetPreparationRecord" ("id" TEXT NOT NULL PRIMARY KEY, "ownerId" TEXT NOT NULL, "kind" TEXT NOT NULL, "period" TEXT NOT NULL, "datasetHash" TEXT NOT NULL, "sourcePayload" TEXT, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE "TaxAssessmentRecord" ("id" TEXT NOT NULL, "ownerId" TEXT NOT NULL, PRIMARY KEY ("ownerId", "id"));
    `)
    database.exec(readFileSync(join(process.cwd(), 'prisma/migrations/20260803190000_narrow_ug_annual_tax/migration.sql'), 'utf8'))
    database.prepare('INSERT INTO "FiscalCloseGeneration" ("id") VALUES (?)').run('close-1')
    const values = ['case-1', 'tenant-a', 2025, 'close-1', 'PREPARED', 'DE-UG-SIMPLE-2025.1', 'UG', 1, '11000000', 41000, 0, 0, 0, 0, 0, 0, 0, 0, '{}', 'source-hash', 'actor-a']
    database.prepare('INSERT INTO "TaxAnnualCaseRecord" ("id","ownerId","year","closeGenerationId","status","ruleVersion","legalForm","establishments","municipalityCode","hebesatzBasisPoints","foreignIncome","groupOrConsolidation","lossCarry","specialRegime","withholdingOrCredits","payroll","incomeAdjustmentCents","tradeAdjustmentCents","previewPayload","sourceChecksum","createdBy") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...values)
    database.prepare('INSERT INTO "TaxDatasetPreparationRecord" ("id","ownerId","kind","period","datasetHash","bindingKind","closeGenerationId","annualCaseId") VALUES (?,?,?,?,?,?,?,?)').run('prep-1', 'tenant-a', 'KST', '2025', 'dataset-hash', 'EXACT_LOCKED_HGB_CLOSE', 'close-1', 'case-1')
    database.exec(readFileSync(join(process.cwd(), 'prisma/migrations/20260804200000_capital_company_annual_tax/migration.sql'), 'utf8'))
    database.prepare('INSERT INTO "TaxAnnualCaseRecord" ("id","ownerId","year","closeGenerationId","status","ruleVersion","legalForm","establishments","municipalityCode","hebesatzBasisPoints","foreignIncome","groupOrConsolidation","lossCarry","specialRegime","withholdingOrCredits","payroll","incomeAdjustmentCents","tradeAdjustmentCents","previewPayload","sourceChecksum","createdBy") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...['case-gmbh-2026', 'tenant-b', 2026, 'close-1', 'PREPARED', 'DE-CAPITAL-COMPANY-2026.1', 'GMBH', 1, '11000000', 41000, 0, 0, 0, 0, 0, 0, 0, 0, '{}', 'gmbh-source-hash', 'actor-b'])
    expect(database.prepare('SELECT "year", "legalForm", "ruleVersion" FROM "TaxAnnualCaseRecord" WHERE "id"=?').get('case-gmbh-2026')).toEqual({ year: 2026, legalForm: 'GMBH', ruleVersion: 'DE-CAPITAL-COMPANY-2026.1' })
    expect(() => database.prepare('UPDATE "TaxAnnualCaseRecord" SET "previewPayload" = ? WHERE "id" = ?').run('{"changed":true}', 'case-1')).toThrow(/immutable/)
    expect(() => database.prepare('UPDATE "TaxDatasetPreparationRecord" SET "datasetHash" = ? WHERE "id" = ?').run('changed', 'prep-1')).toThrow(/immutable/)
    expect(() => database.prepare('INSERT INTO "TaxAnnualCaseRecord" ("id","ownerId","year","closeGenerationId","status","ruleVersion","legalForm","establishments","municipalityCode","hebesatzBasisPoints","foreignIncome","groupOrConsolidation","lossCarry","specialRegime","withholdingOrCredits","payroll","incomeAdjustmentCents","tradeAdjustmentCents","previewPayload","sourceChecksum","createdBy") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...['case-superseded', 'tenant-a', 2025, 'close-1', 'SUPERSEDED', 'DE-UG-SIMPLE-2025.1', 'UG', 1, '11000000', 41000, 0, 0, 0, 0, 0, 0, 0, 0, '{}', 'superseded-hash', 'actor-a'])).toThrow(/CHECK/)
    expect(() => database.prepare('INSERT INTO "TaxAnnualCaseRecord" ("id","ownerId","year","closeGenerationId","ruleVersion","legalForm","establishments","municipalityCode","hebesatzBasisPoints","foreignIncome","groupOrConsolidation","lossCarry","specialRegime","withholdingOrCredits","payroll","incomeAdjustmentCents","tradeAdjustmentCents","previewPayload","sourceChecksum","createdBy") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('case-unsupported', 'tenant-a', 2025, 'close-1', 'DE-UG-SIMPLE-2025.1', 'UG', 1, '11000000', 41000, 1, 0, 0, 0, 0, 0, 0, 0, '{}', 'other-hash', 'actor-a')).toThrow(/CHECK/)
    database.prepare('INSERT INTO "TaxAssessmentRecord" ("id","ownerId","noticeId","noticePayloadHash") VALUES (?,?,?,?)').run('assessment-1', 'tenant-a', 'KSt-2025-1', 'payload-1')
    expect(() => database.prepare('INSERT INTO "TaxAssessmentRecord" ("id","ownerId","noticeId","noticePayloadHash") VALUES (?,?,?,?)').run('assessment-2', 'tenant-a', 'KSt-2025-1', 'payload-2')).toThrow(/UNIQUE/)
    database.prepare('INSERT INTO "TaxAssessmentRecord" ("id","ownerId","noticeId","noticePayloadHash") VALUES (?,?,?,?)').run('assessment-2', 'tenant-b', 'KSt-2025-1', 'payload-2')
    database.close()
  })
})
