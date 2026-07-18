PRAGMA foreign_keys=OFF;
CREATE TABLE "AccountRecord_new" ("id" TEXT NOT NULL PRIMARY KEY, "ownerId" TEXT, "payload" TEXT NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
INSERT INTO "AccountRecord_new" ("id", "payload") SELECT "id", "payload" FROM "AccountRecord";
DROP TABLE "AccountRecord";
ALTER TABLE "AccountRecord_new" RENAME TO "AccountRecord";
CREATE UNIQUE INDEX "AccountRecord_ownerId_key" ON "AccountRecord"("ownerId");
PRAGMA foreign_keys=ON;
CREATE TABLE "CompanyProfileVersion" ("id" TEXT NOT NULL PRIMARY KEY, "ownerId" TEXT NOT NULL, "effectiveFrom" DATETIME NOT NULL, "effectiveTo" DATETIME, "payload" TEXT NOT NULL, "createdBy" TEXT NOT NULL, "reason" TEXT NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX "CompanyProfileVersion_ownerId_effectiveFrom_key" ON "CompanyProfileVersion"("ownerId", "effectiveFrom");
CREATE INDEX "CompanyProfileVersion_ownerId_effectiveFrom_effectiveTo_idx" ON "CompanyProfileVersion"("ownerId", "effectiveFrom", "effectiveTo");
CREATE TABLE "AuditEvent" ("id" TEXT NOT NULL PRIMARY KEY, "ownerId" TEXT NOT NULL, "actorId" TEXT NOT NULL, "occurredAt" DATETIME NOT NULL, "action" TEXT NOT NULL, "reason" TEXT NOT NULL, "objectType" TEXT NOT NULL, "objectId" TEXT NOT NULL, "semanticDelta" TEXT NOT NULL, "previousHash" TEXT, "hash" TEXT NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX "AuditEvent_ownerId_hash_key" ON "AuditEvent"("ownerId", "hash");
CREATE INDEX "AuditEvent_ownerId_occurredAt_idx" ON "AuditEvent"("ownerId", "occurredAt");
CREATE TABLE "BackupManifest" ("id" TEXT NOT NULL PRIMARY KEY, "ownerId" TEXT NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "databaseHash" TEXT NOT NULL, "objectStoreHash" TEXT NOT NULL, "encryptionKeyId" TEXT NOT NULL, "storageRegion" TEXT NOT NULL, "recoveryPointAt" DATETIME NOT NULL, "verifiedAt" DATETIME, "restoredAt" DATETIME, "manifest" TEXT NOT NULL);
CREATE INDEX "BackupManifest_ownerId_createdAt_idx" ON "BackupManifest"("ownerId", "createdAt");
CREATE TABLE "RetainedArtifact" ("id" TEXT NOT NULL PRIMARY KEY, "ownerId" TEXT NOT NULL, "objectType" TEXT NOT NULL, "objectId" TEXT NOT NULL, "version" INTEGER NOT NULL, "retentionClass" TEXT NOT NULL, "contentHash" TEXT NOT NULL, "provenance" TEXT NOT NULL, "storageKey" TEXT, "periodEndsAt" DATETIME NOT NULL, "retainUntil" DATETIME NOT NULL, "legalHoldUntil" DATETIME, "disposedAt" DATETIME, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX "RetainedArtifact_ownerId_objectType_objectId_version_key" ON "RetainedArtifact"("ownerId", "objectType", "objectId", "version");
CREATE INDEX "RetainedArtifact_ownerId_retainUntil_legalHoldUntil_idx" ON "RetainedArtifact"("ownerId", "retainUntil", "legalHoldUntil");
CREATE TABLE "FixityCheck" ("id" TEXT NOT NULL PRIMARY KEY, "ownerId" TEXT NOT NULL, "artifactId" TEXT NOT NULL, "expectedHash" TEXT NOT NULL, "actualHash" TEXT, "status" TEXT NOT NULL, "readable" BOOLEAN NOT NULL, "checkedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX "FixityCheck_ownerId_artifactId_checkedAt_idx" ON "FixityCheck"("ownerId", "artifactId", "checkedAt");
CREATE TABLE "AccountMappingVersion" ("id" TEXT NOT NULL PRIMARY KEY, "ownerId" TEXT NOT NULL, "chartId" TEXT NOT NULL, "accountNumber" INTEGER NOT NULL, "effectiveFrom" DATETIME NOT NULL, "effectiveTo" DATETIME, "accountName" TEXT NOT NULL, "accountType" TEXT NOT NULL, "normalBalance" TEXT NOT NULL, "hgbPosition" TEXT NOT NULL, "eBilanzPosition" TEXT NOT NULL, "vatCode" TEXT, "active" BOOLEAN NOT NULL DEFAULT true, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX "AccountMappingVersion_ownerId_chartId_accountNumber_effectiveFrom_key" ON "AccountMappingVersion"("ownerId", "chartId", "accountNumber", "effectiveFrom");
CREATE INDEX "AccountMappingVersion_ownerId_effectiveFrom_effectiveTo_idx" ON "AccountMappingVersion"("ownerId", "effectiveFrom", "effectiveTo");
CREATE UNIQUE INDEX "FiscalYear_ownerId_startsAt_endsAt_key" ON "FiscalYear"("ownerId", "startsAt", "endsAt");
CREATE INDEX "FiscalYear_ownerId_startsAt_endsAt_idx" ON "FiscalYear"("ownerId", "startsAt", "endsAt");
PRAGMA foreign_keys=OFF;
CREATE TABLE "JournalEntry_new" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "sequenceNumber" INTEGER NOT NULL,
  "bookingDate" DATETIME NOT NULL,
  "documentNumber" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'MANUAL',
  "state" TEXT NOT NULL DEFAULT 'POSTED',
  "entryDate" DATETIME DEFAULT CURRENT_TIMESTAMP,
  "lateReason" TEXT,
  "reversalOfId" TEXT,
  "replacementOfId" TEXT,
  "externalKey" TEXT,
  "fiscalYearId" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "JournalEntry_fiscalYearId_fkey" FOREIGN KEY ("fiscalYearId") REFERENCES "FiscalYear" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "JournalEntry_new" ("id", "sequenceNumber", "bookingDate", "documentNumber", "description", "source", "state", "entryDate", "externalKey", "fiscalYearId", "createdAt")
SELECT "id", "sequenceNumber", "bookingDate", "documentNumber", "description", "source", 'POSTED', NULL, "externalKey", "fiscalYearId", "createdAt" FROM "JournalEntry";
DROP TABLE "JournalEntry";
ALTER TABLE "JournalEntry_new" RENAME TO "JournalEntry";
CREATE UNIQUE INDEX "JournalEntry_externalKey_key" ON "JournalEntry"("externalKey");
CREATE UNIQUE INDEX "JournalEntry_fiscalYearId_sequenceNumber_key" ON "JournalEntry"("fiscalYearId", "sequenceNumber");
CREATE UNIQUE INDEX "JournalEntry_fiscalYearId_documentNumber_key" ON "JournalEntry"("fiscalYearId", "documentNumber");
CREATE INDEX "JournalEntry_bookingDate_idx" ON "JournalEntry"("bookingDate");
CREATE UNIQUE INDEX "JournalEntry_reversalOfId_key" ON "JournalEntry"("reversalOfId");
CREATE UNIQUE INDEX "JournalEntry_replacementOfId_key" ON "JournalEntry"("replacementOfId");
PRAGMA foreign_keys=ON;
CREATE TABLE "PeriodReopenRequest" ("id" TEXT NOT NULL PRIMARY KEY, "ownerId" TEXT NOT NULL, "fiscalYearId" TEXT NOT NULL, "requestedBy" TEXT NOT NULL, "approvedBy" TEXT, "reason" TEXT NOT NULL, "status" TEXT NOT NULL, "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "decidedAt" DATETIME);
CREATE INDEX "PeriodReopenRequest_ownerId_fiscalYearId_requestedAt_idx" ON "PeriodReopenRequest"("ownerId", "fiscalYearId", "requestedAt");
