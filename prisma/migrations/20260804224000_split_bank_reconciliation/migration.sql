DROP TRIGGER "BankTransactionMatch_validate_insert";

CREATE TRIGGER "BankTransactionMatch_validate_insert" BEFORE INSERT ON "BankTransactionMatch" BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM "SettlementAllocation" allocation
    JOIN "PaymentSettlement" settlement ON settlement."ownerId"=allocation."ownerId" AND settlement."id"=allocation."settlementId"
    JOIN "BankTransaction" bankTransaction ON bankTransaction."ownerId"=NEW."ownerId" AND bankTransaction."id"=NEW."bankTransactionId"
    WHERE allocation."ownerId"=NEW."ownerId" AND allocation."id"=NEW."allocationId"
      AND allocation."openItemId"=NEW."openItemId" AND allocation."settlementId"=NEW."settlementId"
      AND allocation."kind"=NEW."kind"
      AND allocation."journalEntryId"=NEW."journalEntryId"
      AND settlement."journalEntryId"=CASE WHEN NEW."kind"='APPLY' THEN NEW."journalEntryId" ELSE settlement."journalEntryId" END
      AND settlement."amountCents"=ABS(NEW."amountCents")
      AND ABS(allocation."amountCents")<=ABS(NEW."amountCents")
      AND ABS(bankTransaction."amountCents")=ABS(NEW."amountCents")
  ) THEN RAISE(ABORT,'bank match allocation facts are inconsistent') END;
  SELECT CASE WHEN NEW."kind"='APPLY' AND EXISTS (
    SELECT 1 FROM "BankTransactionMatch" prior WHERE prior."ownerId"=NEW."ownerId" AND prior."bankTransactionId"=NEW."bankTransactionId" AND prior."kind"='APPLY'
      AND NOT EXISTS (SELECT 1 FROM "BankTransactionMatch" reversal WHERE reversal."ownerId"=prior."ownerId" AND reversal."reversesMatchId"=prior."id")
  ) THEN RAISE(ABORT,'bank transaction already has an active match') END;
  SELECT CASE WHEN NEW."kind"='REVERSAL' AND NOT EXISTS (
    SELECT 1 FROM "BankTransactionMatch" prior WHERE prior."ownerId"=NEW."ownerId" AND prior."id"=NEW."reversesMatchId" AND prior."kind"='APPLY'
      AND prior."bankTransactionId"=NEW."bankTransactionId" AND prior."openItemId"=NEW."openItemId" AND prior."settlementId"=NEW."settlementId"
      AND NEW."amountCents"=-prior."amountCents"
      AND EXISTS (SELECT 1 FROM "SettlementAllocation" reversalAllocation WHERE reversalAllocation."ownerId"=NEW."ownerId" AND reversalAllocation."id"=NEW."allocationId" AND reversalAllocation."reversesAllocationId"=prior."allocationId")
      AND NOT EXISTS (SELECT 1 FROM "BankTransactionMatch" reversal WHERE reversal."ownerId"=prior."ownerId" AND reversal."reversesMatchId"=prior."id")
  ) THEN RAISE(ABORT,'invalid bank match reversal') END;
END;
