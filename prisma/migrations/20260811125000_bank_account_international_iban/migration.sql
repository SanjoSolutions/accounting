PRAGMA foreign_keys=OFF;

CREATE TABLE "BankAccount_new" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "iban" TEXT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'EUR',
  "ledgerAccountId" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (length(trim("name")) > 0),
  CHECK (length("iban") BETWEEN 15 AND 34 AND "iban" GLOB '[A-Z][A-Z][0-9][0-9]*' AND "iban" NOT GLOB '*[^A-Z0-9]*'),
  CHECK ("currency" = 'EUR'),
  CONSTRAINT "BankAccount_ownerId_ledgerAccountId_fkey" FOREIGN KEY ("ownerId", "ledgerAccountId") REFERENCES "LedgerAccount"("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

INSERT INTO "BankAccount_new" ("id", "ownerId", "name", "iban", "currency", "ledgerAccountId", "active", "createdAt", "updatedAt")
SELECT "id", "ownerId", "name", "iban", "currency", "ledgerAccountId", "active", "createdAt", "updatedAt" FROM "BankAccount";

DROP TABLE "BankAccount";
ALTER TABLE "BankAccount_new" RENAME TO "BankAccount";
CREATE UNIQUE INDEX "BankAccount_ownerId_id_key" ON "BankAccount"("ownerId", "id");
CREATE UNIQUE INDEX "BankAccount_ownerId_iban_key" ON "BankAccount"("ownerId", "iban");
CREATE INDEX "BankAccount_ownerId_active_idx" ON "BankAccount"("ownerId", "active");

PRAGMA foreign_keys=ON;
