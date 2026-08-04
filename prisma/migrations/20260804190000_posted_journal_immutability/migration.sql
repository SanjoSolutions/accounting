-- Posted journals are append-only. Corrections must be represented by new
-- reversal/replacement entries; the original entry and its evidence remain
-- unchanged. Draft journals remain editable until their POSTED transition.
CREATE TRIGGER "JournalEntry_posted_no_update"
BEFORE UPDATE ON "JournalEntry"
WHEN OLD."state" = 'POSTED'
BEGIN
  SELECT RAISE(ABORT, 'posted journal entries are append-only');
END;

CREATE TRIGGER "JournalEntry_posted_no_delete"
BEFORE DELETE ON "JournalEntry"
WHEN OLD."state" = 'POSTED'
BEGIN
  SELECT RAISE(ABORT, 'posted journal entries are append-only');
END;

CREATE TRIGGER "JournalLine_posted_no_update"
BEFORE UPDATE ON "JournalLine"
WHEN EXISTS (
  SELECT 1 FROM "JournalEntry" entry
  WHERE entry."id" = OLD."journalEntryId" AND entry."state" = 'POSTED'
)
BEGIN
  SELECT RAISE(ABORT, 'posted journal lines are append-only');
END;

CREATE TRIGGER "JournalLine_posted_no_delete"
BEFORE DELETE ON "JournalLine"
WHEN EXISTS (
  SELECT 1 FROM "JournalEntry" entry
  WHERE entry."id" = OLD."journalEntryId" AND entry."state" = 'POSTED'
)
BEGIN
  SELECT RAISE(ABORT, 'posted journal lines are append-only');
END;

CREATE TRIGGER "JournalDocumentAttachment_posted_no_update"
BEFORE UPDATE ON "JournalDocumentAttachment"
WHEN EXISTS (
  SELECT 1 FROM "JournalEntry" entry
  WHERE entry."id" = OLD."journalEntryId" AND entry."state" = 'POSTED'
)
BEGIN
  SELECT RAISE(ABORT, 'posted journal evidence links are append-only');
END;

CREATE TRIGGER "JournalDocumentAttachment_posted_no_delete"
BEFORE DELETE ON "JournalDocumentAttachment"
WHEN EXISTS (
  SELECT 1 FROM "JournalEntry" entry
  WHERE entry."id" = OLD."journalEntryId" AND entry."state" = 'POSTED'
)
BEGIN
  SELECT RAISE(ABORT, 'posted journal evidence links are append-only');
END;

-- Canonical VAT facts are immutable once recorded. Corrections append a new
-- negative/reversal fact and never rewrite the original fact.
CREATE TRIGGER "VatPostingRecord_no_update"
BEFORE UPDATE ON "VatPostingRecord"
BEGIN
  SELECT RAISE(ABORT, 'VAT posting facts are append-only');
END;

CREATE TRIGGER "VatPostingRecord_no_delete"
BEFORE DELETE ON "VatPostingRecord"
BEGIN
  SELECT RAISE(ABORT, 'VAT posting facts are append-only');
END;
