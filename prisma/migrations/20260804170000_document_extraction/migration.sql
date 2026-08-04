CREATE TABLE "DocumentExtraction" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "providerVersion" TEXT NOT NULL,
  "inputHash" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "extractedData" TEXT,
  "rawTextHash" TEXT,
  "failureCode" TEXT,
  "failureMessage" TEXT,
  "retryable" BOOLEAN NOT NULL DEFAULT false,
  "reviewedBy" TEXT,
  "reviewedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "DocumentExtraction_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "DocumentRecord" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "DocumentExtraction_documentId_key" ON "DocumentExtraction"("documentId");
CREATE UNIQUE INDEX "DocumentExtraction_ownerId_documentId_key" ON "DocumentExtraction"("ownerId", "documentId");
CREATE INDEX "DocumentExtraction_ownerId_status_updatedAt_idx" ON "DocumentExtraction"("ownerId", "status", "updatedAt");
CREATE INDEX "DocumentExtraction_ownerId_inputHash_idx" ON "DocumentExtraction"("ownerId", "inputHash");
