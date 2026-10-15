-- Allocation status describes the allocated balance, not payment availability.
-- Derive terminal reversal from immutable posted journals and bank matches so
-- historical reversed payments are protected without rewriting their evidence.
CREATE TRIGGER "SettlementAllocation_payment_not_reversed"
BEFORE INSERT ON "SettlementAllocation"
WHEN NEW."kind" = 'APPLY'
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM "PaymentSettlement" payment
    JOIN "JournalEntry" reversal ON reversal."ownerId" = payment."ownerId"
      AND reversal."reversalOfId" = payment."journalEntryId" AND reversal."state" = 'POSTED'
    WHERE payment."ownerId" = NEW."ownerId" AND payment."id" = NEW."settlementId"
  ) OR EXISTS (
    SELECT 1 FROM "BankTransactionMatch" reversal
    WHERE reversal."ownerId" = NEW."ownerId" AND reversal."settlementId" = NEW."settlementId"
      AND reversal."kind" = 'REVERSAL'
  ) THEN RAISE(ABORT, 'payment has been reversed and cannot be allocated') END;
END;

-- The opposite write ordering must also fail closed: a reversal cannot finish
-- while an allocation (including credit applied after matching) remains active.
-- SQLite serializes writers; together these guards cover either race winner.
CREATE TRIGGER "BankTransactionMatch_reversal_requires_no_active_allocations"
BEFORE INSERT ON "BankTransactionMatch"
WHEN NEW."kind" = 'REVERSAL'
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM "SettlementAllocation" allocation
    WHERE allocation."ownerId" = NEW."ownerId" AND allocation."settlementId" = NEW."settlementId"
      AND allocation."kind" = 'APPLY'
      AND NOT EXISTS (
        SELECT 1 FROM "SettlementAllocation" reversal
        WHERE reversal."ownerId" = allocation."ownerId" AND reversal."reversesAllocationId" = allocation."id"
      )
  ) THEN RAISE(ABORT, 'bank match reversal cannot leave active payment allocations') END;
END;
