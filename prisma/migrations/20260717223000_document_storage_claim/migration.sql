CREATE TABLE "DocumentStorageClaim" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "importId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "createdStorage" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "DocumentStorageClaim_importId_documentId_key" ON "DocumentStorageClaim"("importId", "documentId");
CREATE INDEX "DocumentStorageClaim_documentId_idx" ON "DocumentStorageClaim"("documentId");
CREATE INDEX "DocumentStorageClaim_createdAt_idx" ON "DocumentStorageClaim"("createdAt");
