ALTER TABLE "DocumentRecord" ADD COLUMN "availableForBooking" BOOLEAN NOT NULL DEFAULT true;

UPDATE "DocumentRecord"
SET "availableForBooking" = false
WHERE EXISTS (
  SELECT 1
  FROM "JournalDocumentAttachment"
  WHERE "JournalDocumentAttachment"."documentId" = "DocumentRecord"."id"
);

CREATE INDEX "DocumentRecord_ownerId_availableForBooking_idx"
ON "DocumentRecord"("ownerId", "availableForBooking");

CREATE TRIGGER "JournalDocumentAttachment_remove_from_booking_inbox"
AFTER INSERT ON "JournalDocumentAttachment"
BEGIN
  UPDATE "DocumentRecord"
  SET "availableForBooking" = false
  WHERE "id" = NEW."documentId";
END;
