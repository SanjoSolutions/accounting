PRAGMA foreign_keys=OFF;

CREATE TABLE "TaxAnnualCaseRecord_capital_company" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "year" INTEGER NOT NULL CHECK ("year" IN (2025, 2026)),
  "closeGenerationId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PREPARED' CHECK ("status" = 'PREPARED'),
  "ruleVersion" TEXT NOT NULL CHECK ("ruleVersion" IN ('DE-UG-SIMPLE-2025.1', 'DE-CAPITAL-COMPANY-2025.1', 'DE-CAPITAL-COMPANY-2026.1')),
  "legalForm" TEXT NOT NULL CHECK ("legalForm" IN ('UG', 'GMBH')),
  "establishments" INTEGER NOT NULL CHECK ("establishments" = 1),
  "municipalityCode" TEXT NOT NULL CHECK (length("municipalityCode") = 8 AND "municipalityCode" NOT GLOB '*[^0-9]*'),
  "hebesatzBasisPoints" INTEGER NOT NULL CHECK ("hebesatzBasisPoints" >= 20000),
  "foreignIncome" BOOLEAN NOT NULL CHECK ("foreignIncome" = 0),
  "groupOrConsolidation" BOOLEAN NOT NULL CHECK ("groupOrConsolidation" = 0),
  "lossCarry" BOOLEAN NOT NULL CHECK ("lossCarry" = 0),
  "specialRegime" BOOLEAN NOT NULL CHECK ("specialRegime" = 0),
  "withholdingOrCredits" BOOLEAN NOT NULL CHECK ("withholdingOrCredits" = 0),
  "payroll" BOOLEAN NOT NULL CHECK ("payroll" = 0),
  "incomeAdjustmentCents" INTEGER NOT NULL,
  "tradeAdjustmentCents" INTEGER NOT NULL,
  "previewPayload" TEXT NOT NULL,
  "sourceChecksum" TEXT NOT NULL,
  "createdBy" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TaxAnnualCaseRecord_closeGenerationId_fkey" FOREIGN KEY ("closeGenerationId") REFERENCES "FiscalCloseGeneration" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

INSERT INTO "TaxAnnualCaseRecord_capital_company" SELECT * FROM "TaxAnnualCaseRecord";
DROP TABLE "TaxAnnualCaseRecord";
ALTER TABLE "TaxAnnualCaseRecord_capital_company" RENAME TO "TaxAnnualCaseRecord";

CREATE UNIQUE INDEX "TaxAnnualCaseRecord_ownerId_sourceChecksum_key" ON "TaxAnnualCaseRecord"("ownerId", "sourceChecksum");
CREATE INDEX "TaxAnnualCaseRecord_ownerId_year_createdAt_idx" ON "TaxAnnualCaseRecord"("ownerId", "year", "createdAt");
CREATE INDEX "TaxAnnualCaseRecord_closeGenerationId_idx" ON "TaxAnnualCaseRecord"("closeGenerationId");
CREATE TRIGGER "TaxAnnualCaseRecord_immutable_update" BEFORE UPDATE ON "TaxAnnualCaseRecord" BEGIN SELECT RAISE(ABORT, 'annual tax cases are immutable'); END;
CREATE TRIGGER "TaxAnnualCaseRecord_immutable_delete" BEFORE DELETE ON "TaxAnnualCaseRecord" BEGIN SELECT RAISE(ABORT, 'annual tax cases are immutable'); END;

PRAGMA foreign_keys=ON;
