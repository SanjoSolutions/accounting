CREATE TABLE "DocumentSearchIndex" (
    "documentId" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "text" TEXT NOT NULL DEFAULT '',
    "source" TEXT,
    "inputHash" TEXT,
    "failureCode" TEXT,
    "attemptId" TEXT,
    "leaseUntil" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DocumentSearchIndex_ownerId_documentId_fkey" FOREIGN KEY ("ownerId", "documentId") REFERENCES "DocumentRecord" ("ownerId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "DocumentSearchIndex_ownerId_status_idx" ON "DocumentSearchIndex"("ownerId", "status");
CREATE UNIQUE INDEX "DocumentSearchIndex_ownerId_documentId_key" ON "DocumentSearchIndex"("ownerId", "documentId");
