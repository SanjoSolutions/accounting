CREATE TABLE "HgbReviewPolicyRecord" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "fiscalPeriodId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "payload" TEXT NOT NULL,
  "checksum" TEXT NOT NULL,
  "selectedBy" TEXT NOT NULL,
  "selectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "HgbReviewPolicyRecord_ownerId_fiscalPeriodId_version_key" ON "HgbReviewPolicyRecord"("ownerId", "fiscalPeriodId", "version");
CREATE TRIGGER "HgbReviewPolicyRecord_immutable_update" BEFORE UPDATE ON "HgbReviewPolicyRecord"
BEGIN SELECT RAISE(ABORT, 'HGB review policy history is immutable'); END;
CREATE TRIGGER "HgbReviewPolicyRecord_immutable_delete" BEFORE DELETE ON "HgbReviewPolicyRecord"
BEGIN SELECT RAISE(ABORT, 'HGB review policy history is immutable'); END;
ALTER TABLE "HgbWorkpaperRecord" ADD COLUMN "reviewMode" TEXT NOT NULL DEFAULT 'INDEPENDENT';
ALTER TABLE "HgbWorkpaperRecord" ADD COLUMN "reviewPolicyId" TEXT;

ALTER TABLE "HgbWorkpaperRecord" ADD COLUMN "reviewEvidenceChecksum" TEXT;
DROP INDEX "HgbWorkpaperRecord_ownerId_checksum_key";
DROP INDEX "HgbAdjustmentRecord_ownerId_fingerprint_key";
CREATE INDEX "HgbAdjustmentRecord_ownerId_fiscalPeriodId_fingerprint_idx" ON "HgbAdjustmentRecord"("ownerId", "fiscalPeriodId", "fingerprint");
