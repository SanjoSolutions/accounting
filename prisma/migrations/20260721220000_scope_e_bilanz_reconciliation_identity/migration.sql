DROP INDEX "EBalanceReconciliationRecord_ownerId_checksum_key";

CREATE UNIQUE INDEX "EBalanceReconciliationRecord_ownerId_fiscalYearId_kind_checksum_key"
ON "EBalanceReconciliationRecord"("ownerId", "fiscalYearId", "kind", "checksum");
