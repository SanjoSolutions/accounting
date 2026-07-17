CREATE TABLE "JournalDocumentAttachment" (
    "journalEntryId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    CONSTRAINT "JournalDocumentAttachment_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "JournalDocumentAttachment_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "DocumentRecord" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    PRIMARY KEY ("journalEntryId", "documentId")
);

CREATE INDEX "JournalDocumentAttachment_documentId_idx" ON "JournalDocumentAttachment"("documentId");
