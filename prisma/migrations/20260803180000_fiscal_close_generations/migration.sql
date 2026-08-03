CREATE TABLE "FiscalCloseGeneration" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "fiscalYearId" TEXT NOT NULL,
  "generation" INTEGER NOT NULL,
  "hgbCloseRunId" TEXT NOT NULL,
  "hgbCloseRunChecksum" TEXT NOT NULL,
  "snapshotHash" TEXT NOT NULL,
  "lockedAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FiscalCloseGeneration_fiscalYearId_fkey" FOREIGN KEY ("fiscalYearId") REFERENCES "FiscalYear" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "FiscalCloseGeneration_hgbCloseRunId_fkey" FOREIGN KEY ("hgbCloseRunId") REFERENCES "HgbCloseRun" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "FiscalCloseGeneration_ownerId_fiscalYearId_generation_key"
ON "FiscalCloseGeneration"("ownerId", "fiscalYearId", "generation");
CREATE UNIQUE INDEX "FiscalCloseGeneration_ownerId_fiscalYearId_lockedAt_key"
ON "FiscalCloseGeneration"("ownerId", "fiscalYearId", "lockedAt");
CREATE INDEX "FiscalCloseGeneration_ownerId_fiscalYearId_createdAt_idx"
ON "FiscalCloseGeneration"("ownerId", "fiscalYearId", "createdAt");
CREATE INDEX "FiscalCloseGeneration_hgbCloseRunId_idx"
ON "FiscalCloseGeneration"("hgbCloseRunId");

CREATE TRIGGER "FiscalCloseGeneration_immutable_update" BEFORE UPDATE ON "FiscalCloseGeneration"
BEGIN SELECT RAISE(ABORT, 'fiscal close generations are immutable'); END;
CREATE TRIGGER "FiscalCloseGeneration_immutable_delete" BEFORE DELETE ON "FiscalCloseGeneration"
BEGIN SELECT RAISE(ABORT, 'fiscal close generations are immutable'); END;

ALTER TABLE "EBalanceSubmission" ADD COLUMN "closeGenerationId" TEXT
  REFERENCES "FiscalCloseGeneration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "EBalanceSubmission_closeGenerationId_idx" ON "EBalanceSubmission"("closeGenerationId");
CREATE TRIGGER "EBalanceSubmission_source_immutable" BEFORE UPDATE ON "EBalanceSubmission"
WHEN NEW."ownerId" != OLD."ownerId"
  OR NEW."year" != OLD."year"
  OR NEW."fiscalYearId" != OLD."fiscalYearId"
  OR COALESCE(NEW."closeGenerationId", '') != COALESCE(OLD."closeGenerationId", '')
  OR NEW."kind" != OLD."kind"
  OR NEW."idempotencyKey" != OLD."idempotencyKey"
  OR NEW."payloadHash" != OLD."payloadHash"
  OR NEW."requestHash" != OLD."requestHash"
  OR NEW."requestXml" != OLD."requestXml"
BEGIN SELECT RAISE(ABORT, 'E-Bilanz submission source is immutable'); END;

ALTER TABLE "EBalanceLifecycleReport" ADD COLUMN "closeGenerationId" TEXT
  REFERENCES "FiscalCloseGeneration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "EBalanceLifecycleReport_closeGenerationId_idx" ON "EBalanceLifecycleReport"("closeGenerationId");
DROP INDEX "EBalanceLifecycleReport_ownerId_reportChecksum_key";
CREATE UNIQUE INDEX "EBalanceLifecycleReport_ownerId_closeGenerationId_reportChecksum_key"
ON "EBalanceLifecycleReport"("ownerId", "closeGenerationId", "reportChecksum");

DROP TRIGGER "EBalanceLifecycleReport_payload_immutable";
CREATE TRIGGER "EBalanceLifecycleReport_payload_immutable" BEFORE UPDATE ON "EBalanceLifecycleReport"
WHEN NEW."ownerId" != OLD."ownerId"
  OR NEW."fiscalYearId" != OLD."fiscalYearId"
  OR COALESCE(NEW."closeGenerationId", '') != COALESCE(OLD."closeGenerationId", '')
  OR NEW."version" != OLD."version"
  OR NEW."taxonomyVersion" != OLD."taxonomyVersion"
  OR NEW."profileSnapshot" != OLD."profileSnapshot"
  OR NEW."reportPayload" != OLD."reportPayload"
  OR NEW."reportXml" != OLD."reportXml"
  OR NEW."reportChecksum" != OLD."reportChecksum"
  OR NEW."storageKey" != OLD."storageKey"
  OR COALESCE(NEW."supersedesId", '') != COALESCE(OLD."supersedesId", '')
BEGIN SELECT RAISE(ABORT, 'E-Bilanz report payload is immutable'); END;
