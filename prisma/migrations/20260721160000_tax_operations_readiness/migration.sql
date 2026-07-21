CREATE TABLE "InvoiceNumberSequenceOnboarding" (
    "ownerId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "firstUnusedNumber" INTEGER NOT NULL,
    "importedHighestNumber" INTEGER,
    "importedCount" INTEGER NOT NULL,
    "importedNumbersHash" TEXT NOT NULL,
    "confirmedBy" TEXT NOT NULL,
    "reconciledAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InvoiceNumberSequenceOnboarding_pkey" PRIMARY KEY ("ownerId", "year")
);
