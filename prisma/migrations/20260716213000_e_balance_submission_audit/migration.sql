PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_EBalanceSubmission" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "fiscalYearId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "requestXml" TEXT NOT NULL,
    "ericCode" INTEGER,
    "ericMessage" TEXT,
    "resultXml" TEXT,
    "serverResponseXml" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EBalanceSubmission_fiscalYearId_fkey" FOREIGN KEY ("fiscalYearId") REFERENCES "FiscalYear" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_EBalanceSubmission" ("createdAt", "ericCode", "ericMessage", "fiscalYearId", "id", "idempotencyKey", "kind", "ownerId", "requestHash", "requestXml", "resultXml", "serverResponseXml", "status", "year")
SELECT "createdAt", "ericCode", "ericMessage", "fiscalYearId", "id", "id", "kind", "ownerId", "requestHash", '', "resultXml", "serverResponseXml", "status", "year" FROM "EBalanceSubmission";
DROP TABLE "EBalanceSubmission";
ALTER TABLE "new_EBalanceSubmission" RENAME TO "EBalanceSubmission";
CREATE INDEX "EBalanceSubmission_ownerId_year_createdAt_idx" ON "EBalanceSubmission"("ownerId", "year", "createdAt");
CREATE UNIQUE INDEX "EBalanceSubmission_idempotencyKey_key" ON "EBalanceSubmission"("idempotencyKey");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
