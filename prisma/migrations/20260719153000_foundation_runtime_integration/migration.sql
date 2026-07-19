-- AuditEvent existed as reserved schema before any persistent runtime writer.
-- Refuse an automatic migration if unexpected unsigned rows are present;
-- those require an explicit, externally reviewed re-signing procedure.
CREATE TEMP TABLE "AuditHmacMigrationPrecondition" (
  "eventCount" INTEGER NOT NULL CHECK ("eventCount" = 0)
);
INSERT INTO "AuditHmacMigrationPrecondition" ("eventCount") SELECT COUNT(*) FROM "AuditEvent";
DROP TABLE "AuditHmacMigrationPrecondition";

ALTER TABLE "BackupManifest" ADD COLUMN "payloadStorageKey" TEXT;
ALTER TABLE "BackupManifest" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'CREATED';
ALTER TABLE "AuditEvent" ADD COLUMN "integrityKeyId" TEXT NOT NULL DEFAULT 'default';

CREATE TABLE "AuditHead" (
  "ownerId" TEXT NOT NULL PRIMARY KEY,
  "headHash" TEXT,
  "legacyHeadHash" TEXT,
  "legacyEventCount" INTEGER NOT NULL DEFAULT 0,
  "version" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "CompliancePolicy" (
  "ownerId" TEXT NOT NULL PRIMARY KEY,
  "allowedStorageRegions" TEXT NOT NULL,
  "operatorIds" TEXT NOT NULL,
  "recoveryPointObjectiveMinutes" INTEGER NOT NULL,
  "recoveryTimeObjectiveMinutes" INTEGER NOT NULL,
  "backupKeyId" TEXT NOT NULL,
  "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "CompanyProfileAddressConfirmation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "profileVersionId" TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  "createdBy" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "CompanyProfileAddressConfirmation_profileVersionId_key" ON "CompanyProfileAddressConfirmation"("profileVersionId");
CREATE INDEX "CompanyProfileAddressConfirmation_ownerId_createdAt_idx" ON "CompanyProfileAddressConfirmation"("ownerId", "createdAt");

ALTER TABLE "RetainedArtifact" ADD COLUMN "legalHoldReason" TEXT;
ALTER TABLE "RetainedArtifact" ADD COLUMN "lastFixityAt" DATETIME;
ALTER TABLE "RetainedArtifact" ADD COLUMN "disposalRequestedAt" DATETIME;
ALTER TABLE "RetainedArtifact" ADD COLUMN "storageDeletedAt" DATETIME;
ALTER TABLE "FiscalYear" ADD COLUMN "label" TEXT;
ALTER TABLE "PeriodReopenRequest" ADD COLUMN "closeGenerationAt" DATETIME;

CREATE TABLE "JournalDraft" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "fiscalYearId" TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "postedEntryId" TEXT,
  "createdBy" TEXT NOT NULL,
  "updatedBy" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "JournalDraft_ownerId_fiscalYearId_status_idx" ON "JournalDraft"("ownerId", "fiscalYearId", "status");

CREATE TABLE "FilingAmendment" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "originalObjectId" TEXT NOT NULL,
  "requestPayload" TEXT NOT NULL,
  "responsePayload" TEXT,
  "receiptPayload" TEXT,
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "createdBy" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "FilingAmendment_ownerId_kind_originalObjectId_createdAt_idx" ON "FilingAmendment"("ownerId", "kind", "originalObjectId", "createdAt");

CREATE TRIGGER "AuditEvent_no_update"
BEFORE UPDATE ON "AuditEvent"
BEGIN
  SELECT RAISE(ABORT, 'Audit events are append-only');
END;

CREATE TRIGGER "AuditEvent_no_delete"
BEFORE DELETE ON "AuditEvent"
BEGIN
  SELECT RAISE(ABORT, 'Audit events are append-only');
END;

CREATE TRIGGER "CompanyProfileVersion_no_update"
BEFORE UPDATE ON "CompanyProfileVersion"
BEGIN
  SELECT RAISE(ABORT, 'Company profile versions are immutable');
END;

CREATE TRIGGER "CompanyProfileVersion_no_delete"
BEFORE DELETE ON "CompanyProfileVersion"
BEGIN
  SELECT RAISE(ABORT, 'Company profile versions are immutable');
END;

CREATE TRIGGER "CompanyProfileAddressConfirmation_no_update"
BEFORE UPDATE ON "CompanyProfileAddressConfirmation"
BEGIN
  SELECT RAISE(ABORT, 'Company profile address confirmations are immutable');
END;

CREATE TRIGGER "CompanyProfileAddressConfirmation_no_delete"
BEFORE DELETE ON "CompanyProfileAddressConfirmation"
BEGIN
  SELECT RAISE(ABORT, 'Company profile address confirmations are immutable');
END;
