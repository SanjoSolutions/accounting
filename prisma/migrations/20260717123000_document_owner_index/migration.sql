ALTER TABLE "DocumentRecord" ADD COLUMN "ownerId" TEXT;

UPDATE "DocumentRecord"
SET "ownerId" = json_extract("payload", '$.ownerId')
WHERE json_valid("payload") AND json_extract("payload", '$.ownerId') IS NOT NULL;

CREATE INDEX "DocumentRecord_ownerId_idx" ON "DocumentRecord"("ownerId");
