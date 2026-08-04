CREATE TABLE "CorrectionNetting" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "correctionDocumentId" TEXT NOT NULL,
  "originalOpenItemId" TEXT NOT NULL,
  "creditOpenItemId" TEXT NOT NULL,
  "journalEntryId" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "requestKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "effectiveDate" DATETIME NOT NULL,
  "createdBy" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CorrectionNetting_ownerId_correctionDocumentId_fkey" FOREIGN KEY ("ownerId","correctionDocumentId") REFERENCES "CommercialDocument"("ownerId","id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CorrectionNetting_ownerId_originalOpenItemId_fkey" FOREIGN KEY ("ownerId","originalOpenItemId") REFERENCES "OpenItem"("ownerId","id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CorrectionNetting_ownerId_creditOpenItemId_fkey" FOREIGN KEY ("ownerId","creditOpenItemId") REFERENCES "OpenItem"("ownerId","id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CorrectionNetting_ownerId_journalEntryId_fkey" FOREIGN KEY ("ownerId","journalEntryId") REFERENCES "JournalEntry"("ownerId","id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CHECK ("amountCents" >= 0),
  CHECK ("originalOpenItemId" != "creditOpenItemId")
);
CREATE UNIQUE INDEX "CorrectionNetting_ownerId_id_key" ON "CorrectionNetting"("ownerId","id");
CREATE UNIQUE INDEX "CorrectionNetting_ownerId_correctionDocumentId_key" ON "CorrectionNetting"("ownerId","correctionDocumentId");
CREATE UNIQUE INDEX "CorrectionNetting_ownerId_creditOpenItemId_key" ON "CorrectionNetting"("ownerId","creditOpenItemId");
CREATE UNIQUE INDEX "CorrectionNetting_ownerId_requestKey_key" ON "CorrectionNetting"("ownerId","requestKey");
CREATE INDEX "CorrectionNetting_ownerId_originalOpenItemId_createdAt_idx" ON "CorrectionNetting"("ownerId","originalOpenItemId","createdAt");

DROP TRIGGER "OpenItem_derived_balance_guard";
CREATE TRIGGER "OpenItem_derived_balance_guard"
BEFORE UPDATE OF "allocatedAmountCents","status","version" ON "OpenItem"
WHEN NEW."allocatedAmountCents" != COALESCE((SELECT SUM(a."amountCents") FROM "SettlementAllocation" a WHERE a."ownerId"=NEW."ownerId" AND a."openItemId"=NEW."id"),0)
    + COALESCE((SELECT SUM(n."amountCents") FROM "CorrectionNetting" n WHERE n."ownerId"=NEW."ownerId" AND (n."originalOpenItemId"=NEW."id" OR n."creditOpenItemId"=NEW."id")),0)
  OR NEW."status" != CASE WHEN NEW."allocatedAmountCents"=0 THEN 'OPEN' WHEN NEW."allocatedAmountCents"=NEW."originalAmountCents" THEN 'SETTLED' ELSE 'PARTIAL' END
  OR NEW."version" != OLD."version"+1
BEGIN SELECT RAISE(ABORT,'open item balance is derived from immutable allocations and correction nettings'); END;

CREATE TRIGGER "CorrectionNetting_validate_insert" BEFORE INSERT ON "CorrectionNetting" BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM "CommercialDocument" correction
    JOIN "OpenItem" credit ON credit."ownerId"=correction."ownerId" AND credit."commercialDocumentId"=correction."id"
    JOIN "OpenItem" originalItem ON originalItem."ownerId"=NEW."ownerId" AND originalItem."id"=NEW."originalOpenItemId"
    JOIN "CommercialDocument" originalDoc ON originalDoc."ownerId"=originalItem."ownerId" AND originalDoc."id"=originalItem."commercialDocumentId"
    JOIN "JournalEntry" journal ON journal."ownerId"=NEW."ownerId" AND journal."id"=NEW."journalEntryId"
    WHERE correction."ownerId"=NEW."ownerId" AND correction."id"=NEW."correctionDocumentId"
      AND correction."kind"='CREDIT_NOTE' AND correction."status"='POSTED' AND correction."correctsId"=originalDoc."id"
      AND correction."postingJournalEntryId"=journal."id" AND journal."state"='POSTED'
      AND credit."id"=NEW."creditOpenItemId" AND credit."side"='CREDIT' AND originalItem."side"='DEBIT'
      AND credit."currency"=originalItem."currency" AND correction."businessPartnerId"=originalDoc."businessPartnerId"
      AND NEW."amountCents"<=originalItem."originalAmountCents"-originalItem."allocatedAmountCents"
      AND NEW."amountCents"<=credit."originalAmountCents"-credit."allocatedAmountCents"
  ) THEN RAISE(ABORT,'invalid tenant correction netting') END;
END;
CREATE TRIGGER "CorrectionNetting_apply" AFTER INSERT ON "CorrectionNetting" BEGIN
  UPDATE "OpenItem" SET "allocatedAmountCents"="allocatedAmountCents"+NEW."amountCents", "status"=CASE WHEN "allocatedAmountCents"+NEW."amountCents"=0 THEN 'OPEN' WHEN "allocatedAmountCents"+NEW."amountCents"="originalAmountCents" THEN 'SETTLED' ELSE 'PARTIAL' END, "version"="version"+1, "updatedAt"=CURRENT_TIMESTAMP WHERE "ownerId"=NEW."ownerId" AND "id"=NEW."originalOpenItemId";
  UPDATE "OpenItem" SET "allocatedAmountCents"="allocatedAmountCents"+NEW."amountCents", "status"=CASE WHEN "allocatedAmountCents"+NEW."amountCents"=0 THEN 'OPEN' WHEN "allocatedAmountCents"+NEW."amountCents"="originalAmountCents" THEN 'SETTLED' ELSE 'PARTIAL' END, "version"="version"+1, "updatedAt"=CURRENT_TIMESTAMP WHERE "ownerId"=NEW."ownerId" AND "id"=NEW."creditOpenItemId";
END;
CREATE TRIGGER "CorrectionNetting_immutable_update" BEFORE UPDATE ON "CorrectionNetting" BEGIN SELECT RAISE(ABORT,'correction nettings are immutable'); END;
CREATE TRIGGER "CorrectionNetting_immutable_delete" BEFORE DELETE ON "CorrectionNetting" BEGIN SELECT RAISE(ABORT,'correction nettings are immutable'); END;
