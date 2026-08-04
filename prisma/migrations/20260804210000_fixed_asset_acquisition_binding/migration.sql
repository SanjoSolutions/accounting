ALTER TABLE "FixedAssetRecord" ADD COLUMN "acquisitionJournalLineId" TEXT;

CREATE UNIQUE INDEX "FixedAssetRecord_acquisitionJournalLineId_key"
ON "FixedAssetRecord"("acquisitionJournalLineId");
