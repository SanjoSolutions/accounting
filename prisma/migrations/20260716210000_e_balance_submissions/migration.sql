CREATE TABLE "EBalanceSubmission" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "fiscalYearId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "ericCode" INTEGER,
    "ericMessage" TEXT,
    "resultXml" TEXT,
    "serverResponseXml" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EBalanceSubmission_fiscalYearId_fkey" FOREIGN KEY ("fiscalYearId") REFERENCES "FiscalYear" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "EBalanceSubmission_ownerId_year_createdAt_idx" ON "EBalanceSubmission"("ownerId", "year", "createdAt");
