CREATE TABLE "TaxAnnualCaseRecord" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "year" INTEGER NOT NULL CHECK ("year" = 2025),
  "closeGenerationId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PREPARED' CHECK ("status" = 'PREPARED'),
  "ruleVersion" TEXT NOT NULL CHECK ("ruleVersion" = 'DE-UG-SIMPLE-2025.1'),
  "legalForm" TEXT NOT NULL CHECK ("legalForm" = 'UG'),
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
CREATE UNIQUE INDEX "TaxAnnualCaseRecord_ownerId_sourceChecksum_key" ON "TaxAnnualCaseRecord"("ownerId", "sourceChecksum");
CREATE INDEX "TaxAnnualCaseRecord_ownerId_year_createdAt_idx" ON "TaxAnnualCaseRecord"("ownerId", "year", "createdAt");
CREATE INDEX "TaxAnnualCaseRecord_closeGenerationId_idx" ON "TaxAnnualCaseRecord"("closeGenerationId");
CREATE TRIGGER "TaxAnnualCaseRecord_immutable_update" BEFORE UPDATE ON "TaxAnnualCaseRecord" BEGIN SELECT RAISE(ABORT, 'annual tax cases are immutable'); END;
CREATE TRIGGER "TaxAnnualCaseRecord_immutable_delete" BEFORE DELETE ON "TaxAnnualCaseRecord" BEGIN SELECT RAISE(ABORT, 'annual tax cases are immutable'); END;

ALTER TABLE "TaxDatasetPreparationRecord" ADD COLUMN "datasetPayload" TEXT;
ALTER TABLE "TaxDatasetPreparationRecord" ADD COLUMN "sourceChecksum" TEXT;
ALTER TABLE "TaxDatasetPreparationRecord" ADD COLUMN "ruleVersion" TEXT;
ALTER TABLE "TaxDatasetPreparationRecord" ADD COLUMN "bindingKind" TEXT;
ALTER TABLE "TaxDatasetPreparationRecord" ADD COLUMN "closeGenerationId" TEXT REFERENCES "FiscalCloseGeneration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TaxDatasetPreparationRecord" ADD COLUMN "annualCaseId" TEXT REFERENCES "TaxAnnualCaseRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "TaxDatasetPreparationRecord_closeGenerationId_idx" ON "TaxDatasetPreparationRecord"("closeGenerationId");
CREATE INDEX "TaxDatasetPreparationRecord_annualCaseId_idx" ON "TaxDatasetPreparationRecord"("annualCaseId");
CREATE TRIGGER "TaxDatasetPreparationRecord_narrow_immutable_update" BEFORE UPDATE ON "TaxDatasetPreparationRecord"
WHEN OLD."bindingKind" = 'EXACT_LOCKED_HGB_CLOSE'
BEGIN SELECT RAISE(ABORT, 'locked-close tax preparations are immutable'); END;
CREATE TRIGGER "TaxDatasetPreparationRecord_narrow_immutable_delete" BEFORE DELETE ON "TaxDatasetPreparationRecord"
WHEN OLD."bindingKind" = 'EXACT_LOCKED_HGB_CLOSE'
BEGIN SELECT RAISE(ABORT, 'locked-close tax preparations are immutable'); END;

ALTER TABLE "TaxAssessmentRecord" ADD COLUMN "documentId" TEXT;
ALTER TABLE "TaxAssessmentRecord" ADD COLUMN "evidenceStorageKey" TEXT;
ALTER TABLE "TaxAssessmentRecord" ADD COLUMN "authority" TEXT NOT NULL DEFAULT 'FINANZAMT' CHECK ("authority" = 'FINANZAMT');
ALTER TABLE "TaxAssessmentRecord" ADD COLUMN "noticeId" TEXT;
ALTER TABLE "TaxAssessmentRecord" ADD COLUMN "noticePayloadHash" TEXT;
ALTER TABLE "TaxAssessmentRecord" ADD COLUMN "comparisonBasis" TEXT CHECK ("comparisonBasis" IN ('DECLARED_LIABILITY', 'NON_BINDING_PREVIEW'));
ALTER TABLE "TaxAssessmentRecord" ADD COLUMN "previewRuleVersion" TEXT;
ALTER TABLE "TaxAssessmentRecord" ADD COLUMN "annualCaseId" TEXT REFERENCES "TaxAnnualCaseRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "TaxAssessmentRecord_ownerId_noticeId_key" ON "TaxAssessmentRecord"("ownerId", "noticeId");
CREATE INDEX "TaxAssessmentRecord_annualCaseId_idx" ON "TaxAssessmentRecord"("annualCaseId");
CREATE TRIGGER "TaxAssessmentRecord_immutable_update" BEFORE UPDATE ON "TaxAssessmentRecord" BEGIN SELECT RAISE(ABORT, 'Finanzamt assessments are immutable'); END;
CREATE TRIGGER "TaxAssessmentRecord_immutable_delete" BEFORE DELETE ON "TaxAssessmentRecord" BEGIN SELECT RAISE(ABORT, 'Finanzamt assessments are immutable'); END;
