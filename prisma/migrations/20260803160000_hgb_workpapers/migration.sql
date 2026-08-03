CREATE TABLE "HgbWorkpaperRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "fiscalPeriodId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "ruleSetVersion" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "preparedBy" TEXT,
    "preparedAt" DATETIME,
    "reviewedBy" TEXT,
    "reviewedAt" DATETIME,
    "reviewReason" TEXT,
    "supersedesId" TEXT,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "HgbWorkpaperRecord_ownerId_fiscalPeriodId_kind_version_key" ON "HgbWorkpaperRecord"("ownerId", "fiscalPeriodId", "kind", "version");
CREATE UNIQUE INDEX "HgbWorkpaperRecord_ownerId_checksum_key" ON "HgbWorkpaperRecord"("ownerId", "checksum");
CREATE INDEX "HgbWorkpaperRecord_ownerId_fiscalPeriodId_status_idx" ON "HgbWorkpaperRecord"("ownerId", "fiscalPeriodId", "status");

CREATE TABLE "HgbAdjustmentRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "fiscalPeriodId" TEXT NOT NULL,
    "workpaperId" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "idempotencyKey" TEXT,
    "postedEntryId" TEXT,
    "postedBy" TEXT,
    "postedAt" DATETIME,
    "payload" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "HgbAdjustmentRecord_ownerId_workpaperId_proposalId_key" ON "HgbAdjustmentRecord"("ownerId", "workpaperId", "proposalId");
CREATE UNIQUE INDEX "HgbAdjustmentRecord_ownerId_fingerprint_key" ON "HgbAdjustmentRecord"("ownerId", "fingerprint");
CREATE UNIQUE INDEX "HgbAdjustmentRecord_ownerId_idempotencyKey_key" ON "HgbAdjustmentRecord"("ownerId", "idempotencyKey");
CREATE INDEX "HgbAdjustmentRecord_ownerId_fiscalPeriodId_status_idx" ON "HgbAdjustmentRecord"("ownerId", "fiscalPeriodId", "status");
