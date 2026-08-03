CREATE TABLE "HgbCloseRun" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "fiscalPeriodId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "ruleSetVersion" TEXT NOT NULL,
  "ledgerFingerprint" TEXT NOT NULL,
  "inputChecksum" TEXT NOT NULL,
  "checksum" TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  "createdBy" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HgbCloseRun_fiscalPeriodId_fkey" FOREIGN KEY ("fiscalPeriodId") REFERENCES "FiscalYear" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "HgbCloseRun_ownerId_fiscalPeriodId_version_key" ON "HgbCloseRun"("ownerId", "fiscalPeriodId", "version");
CREATE UNIQUE INDEX "HgbCloseRun_ownerId_checksum_key" ON "HgbCloseRun"("ownerId", "checksum");
CREATE INDEX "HgbCloseRun_ownerId_fiscalPeriodId_createdAt_idx" ON "HgbCloseRun"("ownerId", "fiscalPeriodId", "createdAt");

CREATE TRIGGER "HgbCloseRun_immutable_update" BEFORE UPDATE ON "HgbCloseRun"
BEGIN SELECT RAISE(ABORT, 'HGB close runs are immutable'); END;

CREATE TRIGGER "HgbCloseRun_immutable_delete" BEFORE DELETE ON "HgbCloseRun"
BEGIN SELECT RAISE(ABORT, 'HGB close runs are immutable'); END;
