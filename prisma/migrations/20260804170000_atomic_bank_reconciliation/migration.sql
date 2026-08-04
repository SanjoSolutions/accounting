CREATE TABLE "BankTransactionMatch" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "bankTransactionId" TEXT NOT NULL,
  "openItemId" TEXT NOT NULL,
  "settlementId" TEXT NOT NULL,
  "allocationId" TEXT NOT NULL,
  "journalEntryId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "requestKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "reversesMatchId" TEXT,
  "effectiveDate" DATETIME NOT NULL,
  "createdBy" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (("kind"='APPLY' AND "amountCents">0 AND "reversesMatchId" IS NULL) OR ("kind"='REVERSAL' AND "amountCents"<0 AND "reversesMatchId" IS NOT NULL)),
  CHECK (length("requestKey") BETWEEN 16 AND 100),
  CHECK (length("requestHash")=64),
  CONSTRAINT "BankTransactionMatch_ownerId_bankTransactionId_fkey" FOREIGN KEY ("ownerId","bankTransactionId") REFERENCES "BankTransaction"("ownerId","id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BankTransactionMatch_ownerId_openItemId_fkey" FOREIGN KEY ("ownerId","openItemId") REFERENCES "OpenItem"("ownerId","id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BankTransactionMatch_ownerId_settlementId_fkey" FOREIGN KEY ("ownerId","settlementId") REFERENCES "PaymentSettlement"("ownerId","id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BankTransactionMatch_ownerId_allocationId_fkey" FOREIGN KEY ("ownerId","allocationId") REFERENCES "SettlementAllocation"("ownerId","id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BankTransactionMatch_ownerId_journalEntryId_fkey" FOREIGN KEY ("ownerId","journalEntryId") REFERENCES "JournalEntry"("ownerId","id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BankTransactionMatch_ownerId_reversesMatchId_fkey" FOREIGN KEY ("ownerId","reversesMatchId") REFERENCES "BankTransactionMatch"("ownerId","id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "BankTransactionMatch_ownerId_id_key" ON "BankTransactionMatch"("ownerId","id");
CREATE UNIQUE INDEX "BankTransactionMatch_ownerId_requestKey_key" ON "BankTransactionMatch"("ownerId","requestKey");
CREATE UNIQUE INDEX "BankTransactionMatch_ownerId_journalEntryId_key" ON "BankTransactionMatch"("ownerId","journalEntryId");
CREATE UNIQUE INDEX "BankTransactionMatch_ownerId_allocationId_key" ON "BankTransactionMatch"("ownerId","allocationId");
CREATE UNIQUE INDEX "BankTransactionMatch_ownerId_reversesMatchId_key" ON "BankTransactionMatch"("ownerId","reversesMatchId");
CREATE INDEX "BankTransactionMatch_ownerId_bankTransactionId_createdAt_idx" ON "BankTransactionMatch"("ownerId","bankTransactionId","createdAt");

CREATE TRIGGER "BankTransactionMatch_validate_insert" BEFORE INSERT ON "BankTransactionMatch" BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM "SettlementAllocation" allocation WHERE allocation."ownerId"=NEW."ownerId" AND allocation."id"=NEW."allocationId"
      AND allocation."openItemId"=NEW."openItemId" AND allocation."settlementId"=NEW."settlementId" AND allocation."journalEntryId"=NEW."journalEntryId"
      AND allocation."kind"=NEW."kind" AND allocation."amountCents"=NEW."amountCents"
  ) THEN RAISE(ABORT,'bank match allocation facts are inconsistent') END;
  SELECT CASE WHEN NEW."kind"='APPLY' AND EXISTS (
    SELECT 1 FROM "BankTransactionMatch" prior WHERE prior."ownerId"=NEW."ownerId" AND prior."bankTransactionId"=NEW."bankTransactionId" AND prior."kind"='APPLY'
      AND NOT EXISTS (SELECT 1 FROM "BankTransactionMatch" reversal WHERE reversal."ownerId"=prior."ownerId" AND reversal."reversesMatchId"=prior."id")
  ) THEN RAISE(ABORT,'bank transaction already has an active match') END;
  SELECT CASE WHEN NEW."kind"='REVERSAL' AND NOT EXISTS (
    SELECT 1 FROM "BankTransactionMatch" prior WHERE prior."ownerId"=NEW."ownerId" AND prior."id"=NEW."reversesMatchId" AND prior."kind"='APPLY'
      AND prior."bankTransactionId"=NEW."bankTransactionId" AND prior."openItemId"=NEW."openItemId" AND prior."settlementId"=NEW."settlementId"
      AND NEW."amountCents"=-prior."amountCents" AND EXISTS (SELECT 1 FROM "SettlementAllocation" reversalAllocation WHERE reversalAllocation."ownerId"=NEW."ownerId" AND reversalAllocation."id"=NEW."allocationId" AND reversalAllocation."reversesAllocationId"=prior."allocationId")
      AND NOT EXISTS (SELECT 1 FROM "BankTransactionMatch" reversal WHERE reversal."ownerId"=prior."ownerId" AND reversal."reversesMatchId"=prior."id")
  ) THEN RAISE(ABORT,'invalid bank match reversal') END;
END;
CREATE TRIGGER "BankTransactionMatch_immutable_update" BEFORE UPDATE ON "BankTransactionMatch" BEGIN SELECT RAISE(ABORT,'bank transaction matches are immutable'); END;
CREATE TRIGGER "BankTransactionMatch_immutable_delete" BEFORE DELETE ON "BankTransactionMatch" BEGIN SELECT RAISE(ABORT,'bank transaction matches cannot be deleted'); END;
