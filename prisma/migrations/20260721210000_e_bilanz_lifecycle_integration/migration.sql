CREATE TABLE "EBalanceTaxonomyRelease" (
  "version" TEXT NOT NULL PRIMARY KEY,
  "validFrom" DATETIME NOT NULL,
  "validThrough" DATETIME NOT NULL,
  "gaapNamespace" TEXT NOT NULL,
  "gcdNamespace" TEXT NOT NULL,
  "entryPoint" TEXT NOT NULL,
  "archiveSha256" TEXT NOT NULL,
  "archiveStorageKey" TEXT NOT NULL,
  "successorVersion" TEXT,
  "compatibility" TEXT NOT NULL,
  "registeredBy" TEXT NOT NULL,
  "registeredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "EBalanceTaxonomyRelease_archiveSha256_key" ON "EBalanceTaxonomyRelease"("archiveSha256");
CREATE INDEX "EBalanceTaxonomyRelease_validFrom_validThrough_idx" ON "EBalanceTaxonomyRelease"("validFrom", "validThrough");

CREATE TABLE "EBalanceLifecycleReport" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "fiscalYearId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "taxonomyVersion" TEXT NOT NULL,
  "profileSnapshot" TEXT NOT NULL,
  "reportPayload" TEXT NOT NULL,
  "reportXml" TEXT NOT NULL,
  "reportChecksum" TEXT NOT NULL,
  "validationDiagnostics" TEXT,
  "validationEngine" TEXT,
  "validatedAt" DATETIME,
  "storageKey" TEXT NOT NULL,
  "supersedesId" TEXT,
  "approvedBy" TEXT,
  "approvedAt" DATETIME,
  "createdBy" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "EBalanceLifecycleReport_ownerId_fiscalYearId_version_key" ON "EBalanceLifecycleReport"("ownerId", "fiscalYearId", "version");
CREATE UNIQUE INDEX "EBalanceLifecycleReport_ownerId_reportChecksum_key" ON "EBalanceLifecycleReport"("ownerId", "reportChecksum");
CREATE INDEX "EBalanceLifecycleReport_ownerId_fiscalYearId_createdAt_idx" ON "EBalanceLifecycleReport"("ownerId", "fiscalYearId", "createdAt");

CREATE TRIGGER "EBalanceTaxonomyRelease_immutable_update" BEFORE UPDATE ON "EBalanceTaxonomyRelease" BEGIN SELECT RAISE(ABORT, 'taxonomy releases are immutable'); END;
CREATE TRIGGER "EBalanceTaxonomyRelease_immutable_delete" BEFORE DELETE ON "EBalanceTaxonomyRelease" BEGIN SELECT RAISE(ABORT, 'taxonomy releases are immutable'); END;
CREATE TRIGGER "EBalanceLifecycleReport_immutable_delete" BEFORE DELETE ON "EBalanceLifecycleReport" BEGIN SELECT RAISE(ABORT, 'E-Bilanz report history is immutable'); END;
CREATE TRIGGER "EBalanceLifecycleReport_payload_immutable" BEFORE UPDATE ON "EBalanceLifecycleReport"
WHEN NEW."ownerId" != OLD."ownerId"
  OR NEW."fiscalYearId" != OLD."fiscalYearId"
  OR NEW."version" != OLD."version"
  OR NEW."taxonomyVersion" != OLD."taxonomyVersion"
  OR NEW."profileSnapshot" != OLD."profileSnapshot"
  OR NEW."reportPayload" != OLD."reportPayload"
  OR NEW."reportXml" != OLD."reportXml"
  OR NEW."reportChecksum" != OLD."reportChecksum"
  OR NEW."storageKey" != OLD."storageKey"
  OR COALESCE(NEW."supersedesId", '') != COALESCE(OLD."supersedesId", '')
BEGIN SELECT RAISE(ABORT, 'E-Bilanz report payload is immutable'); END;

CREATE TABLE "EBalanceReconciliationRecord" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "fiscalYearId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  "checksum" TEXT NOT NULL,
  "evidenceIds" TEXT NOT NULL,
  "approvedBy" TEXT NOT NULL,
  "approvedAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "EBalanceReconciliationRecord_ownerId_fiscalYearId_kind_id_key" ON "EBalanceReconciliationRecord"("ownerId", "fiscalYearId", "kind", "id");
CREATE UNIQUE INDEX "EBalanceReconciliationRecord_ownerId_checksum_key" ON "EBalanceReconciliationRecord"("ownerId", "checksum");
CREATE INDEX "EBalanceReconciliationRecord_ownerId_fiscalYearId_kind_idx" ON "EBalanceReconciliationRecord"("ownerId", "fiscalYearId", "kind");
CREATE TRIGGER "EBalanceReconciliationRecord_immutable_update" BEFORE UPDATE ON "EBalanceReconciliationRecord" BEGIN SELECT RAISE(ABORT, 'E-Bilanz reconciliation evidence is immutable'); END;
CREATE TRIGGER "EBalanceReconciliationRecord_immutable_delete" BEFORE DELETE ON "EBalanceReconciliationRecord" BEGIN SELECT RAISE(ABORT, 'E-Bilanz reconciliation evidence is immutable'); END;
