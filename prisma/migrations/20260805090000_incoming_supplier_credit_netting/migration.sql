DROP TRIGGER "CorrectionNetting_validate_insert";
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
      AND credit."id"=NEW."creditOpenItemId"
      AND ((correction."direction"='RECEIVABLE' AND originalDoc."direction"='RECEIVABLE' AND credit."side"='CREDIT' AND originalItem."side"='DEBIT')
        OR (correction."direction"='PAYABLE' AND originalDoc."direction"='PAYABLE' AND credit."side"='DEBIT' AND originalItem."side"='CREDIT'))
      AND credit."currency"=originalItem."currency" AND correction."businessPartnerId"=originalDoc."businessPartnerId"
      AND typeof(NEW."amountCents")='integer' AND NEW."amountCents">0 AND NEW."amountCents"<=9007199254740991
      AND NEW."amountCents"<=originalItem."originalAmountCents"-originalItem."allocatedAmountCents"
      AND NEW."amountCents"<=credit."originalAmountCents"-credit."allocatedAmountCents"
  ) THEN RAISE(ABORT,'invalid tenant correction netting') END;
END;
