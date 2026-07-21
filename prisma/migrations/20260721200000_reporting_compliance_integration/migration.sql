CREATE TABLE "CompliancePackage" (
  "id" TEXT NOT NULL PRIMARY KEY, "ownerId" TEXT NOT NULL, "kind" TEXT NOT NULL,
  "fiscalPeriodId" TEXT, "version" INTEGER NOT NULL, "status" TEXT NOT NULL,
  "payload" TEXT NOT NULL, "checksum" TEXT NOT NULL, "storageKey" TEXT,
  "supersedesId" TEXT, "authorityRef" TEXT, "createdBy" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "approvedBy" TEXT, "approvedAt" DATETIME
);
CREATE UNIQUE INDEX "CompliancePackage_ownerId_kind_fiscalPeriodId_version_key" ON "CompliancePackage"("ownerId", "kind", "fiscalPeriodId", "version");
CREATE UNIQUE INDEX "CompliancePackage_ownerId_checksum_key" ON "CompliancePackage"("ownerId", "checksum");
CREATE INDEX "CompliancePackage_ownerId_kind_createdAt_idx" ON "CompliancePackage"("ownerId", "kind", "createdAt");
CREATE TABLE "ProcedureDocumentRecord" (
  "id" TEXT NOT NULL PRIMARY KEY, "ownerId" TEXT NOT NULL, "documentId" TEXT NOT NULL,
  "version" TEXT NOT NULL, "effectiveFrom" DATETIME NOT NULL, "effectiveTo" DATETIME,
  "payload" TEXT NOT NULL, "checksum" TEXT NOT NULL, "approvedBy" TEXT NOT NULL,
  "approvedAt" DATETIME NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ProcedureDocumentRecord_ownerId_documentId_version_key" ON "ProcedureDocumentRecord"("ownerId", "documentId", "version");
CREATE INDEX "ProcedureDocumentRecord_ownerId_effectiveFrom_effectiveTo_idx" ON "ProcedureDocumentRecord"("ownerId", "effectiveFrom", "effectiveTo");
CREATE TABLE "FixedAssetRecord" ("id" TEXT NOT NULL PRIMARY KEY, "ownerId" TEXT NOT NULL, "payload" TEXT NOT NULL, "createdBy" TEXT NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX "FixedAssetRecord_ownerId_createdAt_idx" ON "FixedAssetRecord"("ownerId", "createdAt");
CREATE TABLE "AssetEventRecord" ("id" TEXT NOT NULL PRIMARY KEY, "ownerId" TEXT NOT NULL, "assetId" TEXT NOT NULL, "sequence" INTEGER NOT NULL, "payload" TEXT NOT NULL, "postingId" TEXT NOT NULL, "approvedBy" TEXT NOT NULL, "approvedAt" DATETIME NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX "AssetEventRecord_ownerId_assetId_sequence_key" ON "AssetEventRecord"("ownerId", "assetId", "sequence");
CREATE INDEX "AssetEventRecord_ownerId_assetId_createdAt_idx" ON "AssetEventRecord"("ownerId", "assetId", "createdAt");
CREATE TABLE "InventoryItemRecord" ("id" TEXT NOT NULL PRIMARY KEY, "ownerId" TEXT NOT NULL, "payload" TEXT NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX "InventoryItemRecord_ownerId_createdAt_idx" ON "InventoryItemRecord"("ownerId", "createdAt");
CREATE TABLE "InventoryCountSnapshot" ("id" TEXT NOT NULL PRIMARY KEY, "ownerId" TEXT NOT NULL, "fiscalPeriodId" TEXT NOT NULL, "payload" TEXT NOT NULL, "checksum" TEXT NOT NULL, "closedBy" TEXT NOT NULL, "closedAt" DATETIME NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX "InventoryCountSnapshot_ownerId_fiscalPeriodId_key" ON "InventoryCountSnapshot"("ownerId", "fiscalPeriodId");
CREATE INDEX "InventoryCountSnapshot_ownerId_closedAt_idx" ON "InventoryCountSnapshot"("ownerId", "closedAt");
CREATE TABLE "CashBookRecord" ("id" TEXT NOT NULL PRIMARY KEY, "ownerId" TEXT NOT NULL, "location" TEXT NOT NULL, "register" TEXT NOT NULL, "timeZone" TEXT NOT NULL, "currency" TEXT NOT NULL, "glAccountId" TEXT NOT NULL, "retainedThrough" DATETIME NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX "CashBookRecord_ownerId_location_register_key" ON "CashBookRecord"("ownerId", "location", "register");
CREATE INDEX "CashBookRecord_ownerId_createdAt_idx" ON "CashBookRecord"("ownerId", "createdAt");
CREATE TABLE "CashEntryRecord" ("id" TEXT NOT NULL PRIMARY KEY, "ownerId" TEXT NOT NULL, "cashBookId" TEXT NOT NULL, "sequence" INTEGER NOT NULL, "businessDate" DATETIME NOT NULL, "journalEntryId" TEXT NOT NULL, "payload" TEXT NOT NULL, "correctsEntryId" TEXT, "replacementEntryId" TEXT, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX "CashEntryRecord_ownerId_cashBookId_sequence_key" ON "CashEntryRecord"("ownerId", "cashBookId", "sequence");
CREATE UNIQUE INDEX "CashEntryRecord_ownerId_cashBookId_journalEntryId_key" ON "CashEntryRecord"("ownerId", "cashBookId", "journalEntryId");
CREATE INDEX "CashEntryRecord_ownerId_cashBookId_businessDate_idx" ON "CashEntryRecord"("ownerId", "cashBookId", "businessDate");
CREATE TABLE "CashCloseRecord" ("id" TEXT NOT NULL PRIMARY KEY, "ownerId" TEXT NOT NULL, "cashBookId" TEXT NOT NULL, "businessDate" DATETIME NOT NULL, "payload" TEXT NOT NULL, "checksum" TEXT NOT NULL, "signedBy" TEXT NOT NULL, "approvedBy" TEXT NOT NULL, "closedAt" DATETIME NOT NULL);
CREATE UNIQUE INDEX "CashCloseRecord_ownerId_cashBookId_businessDate_key" ON "CashCloseRecord"("ownerId", "cashBookId", "businessDate");
CREATE INDEX "CashCloseRecord_ownerId_closedAt_idx" ON "CashCloseRecord"("ownerId", "closedAt");

CREATE TRIGGER "ProcedureDocumentRecord_immutable_update" BEFORE UPDATE ON "ProcedureDocumentRecord" BEGIN SELECT RAISE(ABORT, 'procedure history is immutable'); END;
CREATE TRIGGER "ProcedureDocumentRecord_immutable_delete" BEFORE DELETE ON "ProcedureDocumentRecord" BEGIN SELECT RAISE(ABORT, 'procedure history is immutable'); END;
CREATE TRIGGER "CompliancePackage_immutable_delete" BEFORE DELETE ON "CompliancePackage" BEGIN SELECT RAISE(ABORT, 'compliance package history is immutable'); END;
CREATE TRIGGER "CompliancePackage_payload_immutable" BEFORE UPDATE ON "CompliancePackage" WHEN NEW."ownerId" != OLD."ownerId" OR NEW."kind" != OLD."kind" OR NEW."fiscalPeriodId" != OLD."fiscalPeriodId" OR NEW."version" != OLD."version" OR NEW."payload" != OLD."payload" OR NEW."checksum" != OLD."checksum" OR NEW."storageKey" != OLD."storageKey" OR COALESCE(NEW."supersedesId", '') != COALESCE(OLD."supersedesId", '') BEGIN SELECT RAISE(ABORT, 'compliance package payload is immutable'); END;
CREATE TRIGGER "AssetEventRecord_immutable_update" BEFORE UPDATE ON "AssetEventRecord" BEGIN SELECT RAISE(ABORT, 'asset event history is immutable'); END;
CREATE TRIGGER "AssetEventRecord_immutable_delete" BEFORE DELETE ON "AssetEventRecord" BEGIN SELECT RAISE(ABORT, 'asset event history is immutable'); END;
CREATE TRIGGER "InventoryCountSnapshot_immutable_update" BEFORE UPDATE ON "InventoryCountSnapshot" BEGIN SELECT RAISE(ABORT, 'inventory close is immutable'); END;
CREATE TRIGGER "InventoryCountSnapshot_immutable_delete" BEFORE DELETE ON "InventoryCountSnapshot" BEGIN SELECT RAISE(ABORT, 'inventory close is immutable'); END;
CREATE TRIGGER "CashEntryRecord_immutable_update" BEFORE UPDATE ON "CashEntryRecord" BEGIN SELECT RAISE(ABORT, 'cash entry history is immutable'); END;
CREATE TRIGGER "CashEntryRecord_immutable_delete" BEFORE DELETE ON "CashEntryRecord" BEGIN SELECT RAISE(ABORT, 'cash entry history is immutable'); END;
CREATE TRIGGER "CashCloseRecord_immutable_update" BEFORE UPDATE ON "CashCloseRecord" BEGIN SELECT RAISE(ABORT, 'cash close history is immutable'); END;
CREATE TRIGGER "CashCloseRecord_immutable_delete" BEFORE DELETE ON "CashCloseRecord" BEGIN SELECT RAISE(ABORT, 'cash close history is immutable'); END;
