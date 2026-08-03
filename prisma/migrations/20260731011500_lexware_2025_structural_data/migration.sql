ALTER TABLE "JournalEntry" ADD COLUMN "sourcePostingDate" DATETIME;
ALTER TABLE "JournalEntry" ADD COLUMN "sourceJournalDate" DATETIME;
ALTER TABLE "JournalEntry" ADD COLUMN "sourcePeriod" INTEGER;

CREATE TABLE "LexwareCompanySetup" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "year" INTEGER NOT NULL,
  "companyName" TEXT NOT NULL,
  "street" TEXT NOT NULL,
  "postalCode" TEXT NOT NULL,
  "city" TEXT NOT NULL,
  "region" TEXT NOT NULL,
  "phone" TEXT,
  "fax" TEXT,
  "currency" TEXT NOT NULL,
  "accountingMethod" TEXT NOT NULL,
  "chart" TEXT NOT NULL,
  "startsAt" DATETIME NOT NULL,
  "endsAt" DATETIME NOT NULL,
  "taxonomyVersion" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "LexwareCompanySetup_ownerId_year_key" ON "LexwareCompanySetup"("ownerId", "year");
CREATE INDEX "LexwareCompanySetup_ownerId_startsAt_endsAt_idx" ON "LexwareCompanySetup"("ownerId", "startsAt", "endsAt");

CREATE TABLE "LexwareAccountMetadata" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "year" INTEGER NOT NULL,
  "accountNumber" INTEGER NOT NULL,
  "accountName" TEXT NOT NULL,
  "accountCategory" TEXT NOT NULL,
  "subcategory" TEXT,
  "legacyVatPosition" TEXT,
  "legacyVatCode" TEXT,
  "currentVatPosition" TEXT,
  "currentVatCode" TEXT,
  "cashBasisMapping" TEXT,
  "hgbAssetMapping" TEXT,
  "hgbLiabilityMapping" TEXT,
  "hgbIncomeStatementMapping" TEXT,
  "taxonomyAssetMapping" TEXT,
  "taxonomyLiabilityMapping" TEXT,
  "taxonomyIncomeStatementMapping" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "LexwareAccountMetadata_ownerId_year_accountNumber_key" ON "LexwareAccountMetadata"("ownerId", "year", "accountNumber");
CREATE INDEX "LexwareAccountMetadata_ownerId_year_idx" ON "LexwareAccountMetadata"("ownerId", "year");

CREATE TABLE "LexwareTrialBalanceLine" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "year" INTEGER NOT NULL,
  "accountNumber" INTEGER NOT NULL,
  "accountName" TEXT NOT NULL,
  "lastBookingDate" DATETIME,
  "openingDebitCents" INTEGER NOT NULL,
  "openingCreditCents" INTEGER NOT NULL,
  "annualDebitCents" INTEGER NOT NULL,
  "annualCreditCents" INTEGER NOT NULL,
  "cumulativeDebitCents" INTEGER NOT NULL,
  "cumulativeCreditCents" INTEGER NOT NULL,
  "closingDebitCents" INTEGER NOT NULL,
  "closingCreditCents" INTEGER NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "LexwareTrialBalanceLine_ownerId_year_accountNumber_key" ON "LexwareTrialBalanceLine"("ownerId", "year", "accountNumber");
CREATE INDEX "LexwareTrialBalanceLine_ownerId_year_idx" ON "LexwareTrialBalanceLine"("ownerId", "year");

CREATE TABLE "LexwareBusinessPartner" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "year" INTEGER NOT NULL,
  "partnerNumber" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "street" TEXT NOT NULL,
  "houseNumber" TEXT NOT NULL,
  "postalCode" TEXT NOT NULL,
  "city" TEXT NOT NULL,
  "industry" TEXT,
  "vatId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "LexwareBusinessPartner_ownerId_year_partnerNumber_key" ON "LexwareBusinessPartner"("ownerId", "year", "partnerNumber");
CREATE INDEX "LexwareBusinessPartner_ownerId_year_name_idx" ON "LexwareBusinessPartner"("ownerId", "year", "name");

CREATE TABLE "LexwareSubledgerAssociation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "year" INTEGER NOT NULL,
  "accountNumber" INTEGER NOT NULL,
  "partnerNumber" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "LexwareSubledgerAssociation_ownerId_year_accountNumber_partnerNumber_kind_key" ON "LexwareSubledgerAssociation"("ownerId", "year", "accountNumber", "partnerNumber", "kind");
CREATE INDEX "LexwareSubledgerAssociation_ownerId_year_kind_idx" ON "LexwareSubledgerAssociation"("ownerId", "year", "kind");

CREATE TABLE "LexwareAnnualVatField" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "year" INTEGER NOT NULL,
  "fieldCode" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "LexwareAnnualVatField_ownerId_year_fieldCode_key" ON "LexwareAnnualVatField"("ownerId", "year", "fieldCode");
CREATE INDEX "LexwareAnnualVatField_ownerId_year_idx" ON "LexwareAnnualVatField"("ownerId", "year");
