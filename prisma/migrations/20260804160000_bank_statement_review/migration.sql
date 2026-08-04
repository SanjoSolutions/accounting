CREATE UNIQUE INDEX "LedgerAccount_ownerId_id_key" ON "LedgerAccount"("ownerId", "id");

CREATE TABLE "BankAccount" (
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
  CHECK ("iban" GLOB 'DE[0-9]*' AND length("iban") = 22),
  CHECK ("currency" = 'EUR'),
  CONSTRAINT "BankAccount_ownerId_ledgerAccountId_fkey" FOREIGN KEY ("ownerId", "ledgerAccountId") REFERENCES "LedgerAccount"("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "BankAccount_ownerId_id_key" ON "BankAccount"("ownerId", "id");
CREATE UNIQUE INDEX "BankAccount_ownerId_iban_key" ON "BankAccount"("ownerId", "iban");
CREATE INDEX "BankAccount_ownerId_active_idx" ON "BankAccount"("ownerId", "active");

CREATE TABLE "BankStatement" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "bankAccountId" TEXT NOT NULL,
  "externalStatementId" TEXT NOT NULL,
  "format" TEXT NOT NULL DEFAULT 'CAMT053',
  "contentHash" TEXT NOT NULL,
  "originalXml" BLOB NOT NULL,
  "periodStart" DATETIME NOT NULL,
  "periodEnd" DATETIME NOT NULL,
  "openingBalanceCents" INTEGER NOT NULL,
  "closingBalanceCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'EUR',
  "importedBy" TEXT NOT NULL,
  "importedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (length(trim("externalStatementId")) > 0),
  CHECK ("format" = 'CAMT053'),
  CHECK (length("contentHash") = 64),
  CHECK ("currency" = 'EUR'),
  CHECK ("periodStart" <= "periodEnd"),
  CONSTRAINT "BankStatement_ownerId_bankAccountId_fkey" FOREIGN KEY ("ownerId", "bankAccountId") REFERENCES "BankAccount"("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "BankStatement_ownerId_id_key" ON "BankStatement"("ownerId", "id");
CREATE UNIQUE INDEX "BankStatement_ownerId_bankAccountId_externalStatementId_key" ON "BankStatement"("ownerId", "bankAccountId", "externalStatementId");
CREATE UNIQUE INDEX "BankStatement_ownerId_bankAccountId_contentHash_key" ON "BankStatement"("ownerId", "bankAccountId", "contentHash");
CREATE INDEX "BankStatement_ownerId_periodEnd_idx" ON "BankStatement"("ownerId", "periodEnd");

CREATE TABLE "BankTransaction" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "bankAccountId" TEXT NOT NULL,
  "statementId" TEXT NOT NULL,
  "externalKey" TEXT NOT NULL,
  "factHash" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'EUR',
  "bookingDate" DATETIME NOT NULL,
  "valueDate" DATETIME,
  "bankReference" TEXT,
  "counterpartyName" TEXT,
  "counterpartyIban" TEXT,
  "remittance" TEXT,
  "rawData" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ("amountCents" != 0),
  CHECK ("currency" = 'EUR'),
  CHECK (length("externalKey") = 64),
  CHECK (length("factHash") = 64),
  CONSTRAINT "BankTransaction_ownerId_bankAccountId_fkey" FOREIGN KEY ("ownerId", "bankAccountId") REFERENCES "BankAccount"("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BankTransaction_ownerId_statementId_fkey" FOREIGN KEY ("ownerId", "statementId") REFERENCES "BankStatement"("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "BankTransaction_ownerId_id_key" ON "BankTransaction"("ownerId", "id");
CREATE UNIQUE INDEX "BankTransaction_ownerId_bankAccountId_externalKey_key" ON "BankTransaction"("ownerId", "bankAccountId", "externalKey");
CREATE INDEX "BankTransaction_ownerId_bankAccountId_bookingDate_idx" ON "BankTransaction"("ownerId", "bankAccountId", "bookingDate");

CREATE TRIGGER "BankStatement_immutable_update" BEFORE UPDATE ON "BankStatement" BEGIN SELECT RAISE(ABORT, 'bank statements are immutable'); END;
CREATE TRIGGER "BankStatement_immutable_delete" BEFORE DELETE ON "BankStatement" BEGIN SELECT RAISE(ABORT, 'bank statements cannot be deleted'); END;
CREATE TRIGGER "BankTransaction_immutable_update" BEFORE UPDATE ON "BankTransaction" BEGIN SELECT RAISE(ABORT, 'bank transactions are immutable'); END;
CREATE TRIGGER "BankTransaction_immutable_delete" BEFORE DELETE ON "BankTransaction" BEGIN SELECT RAISE(ABORT, 'bank transactions cannot be deleted'); END;
