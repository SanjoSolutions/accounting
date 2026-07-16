ALTER TABLE "BookingRecordEntry" ADD COLUMN "ownerId" TEXT;
CREATE INDEX "BookingRecordEntry_ownerId_idx" ON "BookingRecordEntry"("ownerId");
