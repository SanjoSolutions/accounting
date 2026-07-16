ALTER TABLE "EBalanceSubmission" ADD COLUMN "payloadHash" TEXT NOT NULL DEFAULT '';
DROP INDEX "EBalanceSubmission_idempotencyKey_key";
CREATE UNIQUE INDEX "EBalanceSubmission_ownerId_idempotencyKey_key" ON "EBalanceSubmission"("ownerId", "idempotencyKey");
