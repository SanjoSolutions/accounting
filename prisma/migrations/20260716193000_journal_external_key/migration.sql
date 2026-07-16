ALTER TABLE "JournalEntry" ADD COLUMN "externalKey" TEXT;
CREATE UNIQUE INDEX "JournalEntry_externalKey_key" ON "JournalEntry"("externalKey");
