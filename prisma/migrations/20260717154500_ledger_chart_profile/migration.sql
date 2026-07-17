CREATE TABLE "LedgerProfile" (
    "ownerId" TEXT NOT NULL PRIMARY KEY,
    "chart" TEXT NOT NULL,
    "consultantNumber" TEXT,
    "clientNumber" TEXT,
    "accountLength" INTEGER
);

-- Existing ledgers were created exclusively from the application's SKR03
-- defaults, so their canonical chart is known during the migration.
INSERT INTO "LedgerProfile" ("ownerId", "chart", "accountLength")
SELECT DISTINCT "ownerId", 'SKR03', 4
FROM "LedgerAccount";
