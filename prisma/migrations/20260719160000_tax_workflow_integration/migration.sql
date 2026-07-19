ALTER TABLE "JournalLine" ADD COLUMN "taxPoint" DATETIME;
ALTER TABLE "JournalLine" ADD COLUMN "taxJurisdiction" TEXT;
ALTER TABLE "JournalLine" ADD COLUMN "netBaseCents" INTEGER;
ALTER TABLE "JournalLine" ADD COLUMN "taxRateBasisPoints" INTEGER;
ALTER TABLE "JournalLine" ADD COLUMN "taxAmountCents" INTEGER;
ALTER TABLE "JournalLine" ADD COLUMN "deductibleTaxCents" INTEGER;
ALTER TABLE "JournalLine" ADD COLUMN "taxRuleId" TEXT;
ALTER TABLE "JournalLine" ADD COLUMN "taxRuleVersion" INTEGER;
ALTER TABLE "JournalLine" ADD COLUMN "taxReason" TEXT;

-- Existing SKR04 tenants need the canonical 19% VAT control accounts before
-- tenant-chart-aware reconciliation is enabled. Additive accounts are safe for
-- posted ledgers; existing conflicting account numbers remain untouched and
-- will fail semantic reconciliation validation instead of being overwritten.
INSERT OR IGNORE INTO "LedgerAccount" ("id", "ownerId", "number", "name", "category", "eBilanzPosition", "active", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(16))), p."ownerId",
  1406 * CASE COALESCE(p."accountLength", 4) WHEN 5 THEN 10 WHEN 6 THEN 100 WHEN 7 THEN 1000 WHEN 8 THEN 10000 ELSE 1 END,
  'Abziehbare Vorsteuer 19 %', 'ASSET', 'bs.ass.currAss.receiv.other.vat', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "LedgerProfile" p WHERE p."chart" = 'SKR04';
INSERT OR IGNORE INTO "LedgerAccount" ("id", "ownerId", "number", "name", "category", "eBilanzPosition", "active", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(16))), p."ownerId",
  3806 * CASE COALESCE(p."accountLength", 4) WHEN 5 THEN 10 WHEN 6 THEN 100 WHEN 7 THEN 1000 WHEN 8 THEN 10000 ELSE 1 END,
  'Umsatzsteuer 19 %', 'LIABILITY', 'bs.eqLiab.liab.other.theroffTax.vat', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "LedgerProfile" p WHERE p."chart" = 'SKR04';

INSERT OR IGNORE INTO "AccountMappingVersion" ("id", "ownerId", "chartId", "accountNumber", "effectiveFrom", "effectiveTo", "accountName", "accountType", "normalBalance", "hgbPosition", "eBilanzPosition", "vatCode", "active", "createdAt")
SELECT lower(hex(randomblob(16))), c."ownerId", 'SKR04',
  1406 * CASE COALESCE(p."accountLength", 4) WHEN 5 THEN 10 WHEN 6 THEN 100 WHEN 7 THEN 1000 WHEN 8 THEN 10000 ELSE 1 END,
  c."effectiveFrom", c."effectiveTo", 'Abziehbare Vorsteuer 19 %', 'ASSET', 'DEBIT', 'HGB.266', 'bs.ass.currAss.receiv.other.vat', 'V19', 1, CURRENT_TIMESTAMP
FROM (SELECT DISTINCT "ownerId", "effectiveFrom", "effectiveTo" FROM "AccountMappingVersion" WHERE "chartId" = 'SKR04') c
JOIN "LedgerProfile" p ON p."ownerId" = c."ownerId" AND p."chart" = 'SKR04'
JOIN "LedgerAccount" a ON a."ownerId" = c."ownerId"
  AND a."number" = 1406 * CASE COALESCE(p."accountLength", 4) WHEN 5 THEN 10 WHEN 6 THEN 100 WHEN 7 THEN 1000 WHEN 8 THEN 10000 ELSE 1 END
  AND a."eBilanzPosition" = 'bs.ass.currAss.receiv.other.vat' AND a."category" = 'ASSET';
INSERT OR IGNORE INTO "AccountMappingVersion" ("id", "ownerId", "chartId", "accountNumber", "effectiveFrom", "effectiveTo", "accountName", "accountType", "normalBalance", "hgbPosition", "eBilanzPosition", "vatCode", "active", "createdAt")
SELECT lower(hex(randomblob(16))), c."ownerId", 'SKR04',
  3806 * CASE COALESCE(p."accountLength", 4) WHEN 5 THEN 10 WHEN 6 THEN 100 WHEN 7 THEN 1000 WHEN 8 THEN 10000 ELSE 1 END,
  c."effectiveFrom", c."effectiveTo", 'Umsatzsteuer 19 %', 'LIABILITY', 'CREDIT', 'HGB.266', 'bs.eqLiab.liab.other.theroffTax.vat', 'U19', 1, CURRENT_TIMESTAMP
FROM (SELECT DISTINCT "ownerId", "effectiveFrom", "effectiveTo" FROM "AccountMappingVersion" WHERE "chartId" = 'SKR04') c
JOIN "LedgerProfile" p ON p."ownerId" = c."ownerId" AND p."chart" = 'SKR04'
JOIN "LedgerAccount" a ON a."ownerId" = c."ownerId"
  AND a."number" = 3806 * CASE COALESCE(p."accountLength", 4) WHEN 5 THEN 10 WHEN 6 THEN 100 WHEN 7 THEN 1000 WHEN 8 THEN 10000 ELSE 1 END
  AND a."eBilanzPosition" = 'bs.eqLiab.liab.other.theroffTax.vat' AND a."category" = 'LIABILITY';

CREATE TABLE "StructuredInvoice" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "syntax" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "direction" TEXT NOT NULL,
  "issuerKey" TEXT NOT NULL,
  "invoiceNumber" TEXT NOT NULL,
  "issueDate" DATETIME NOT NULL,
  "structuredHash" TEXT NOT NULL,
  "visualHash" TEXT,
  "originalMediaType" TEXT NOT NULL,
  "structuredOriginal" BLOB NOT NULL,
  "visualOriginal" BLOB,
  "data" TEXT NOT NULL,
  "provenance" TEXT NOT NULL,
  "renderedHtml" TEXT NOT NULL,
  "correctsId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StructuredInvoice_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "DocumentRecord" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "StructuredInvoice_documentId_key" ON "StructuredInvoice"("documentId");
CREATE UNIQUE INDEX "StructuredInvoice_ownerId_direction_issuerKey_invoiceNumber_key" ON "StructuredInvoice"("ownerId", "direction", "issuerKey", "invoiceNumber");
CREATE UNIQUE INDEX "StructuredInvoice_ownerId_structuredHash_key" ON "StructuredInvoice"("ownerId", "structuredHash");
CREATE INDEX "StructuredInvoice_ownerId_issueDate_idx" ON "StructuredInvoice"("ownerId", "issueDate");
CREATE INDEX "StructuredInvoice_ownerId_correctsId_idx" ON "StructuredInvoice"("ownerId", "correctsId");

CREATE TABLE "InvoiceNumberSequence" (
  "ownerId" TEXT NOT NULL,
  "year" INTEGER NOT NULL,
  "nextValue" INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY ("ownerId", "year")
);

CREATE TABLE "InvoiceNumberReservation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "year" INTEGER NOT NULL,
  "sequenceValue" INTEGER NOT NULL,
  "invoiceNumber" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "structuredInvoiceId" TEXT,
  "failureReason" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "InvoiceNumberReservation_ownerId_year_sequenceValue_key" ON "InvoiceNumberReservation"("ownerId", "year", "sequenceValue");
CREATE UNIQUE INDEX "InvoiceNumberReservation_ownerId_invoiceNumber_key" ON "InvoiceNumberReservation"("ownerId", "invoiceNumber");
CREATE INDEX "InvoiceNumberReservation_ownerId_status_createdAt_idx" ON "InvoiceNumberReservation"("ownerId", "status", "createdAt");

CREATE TABLE "InvoiceIssuanceRequest" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "requestKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PROCESSING',
  "reservationId" TEXT,
  "storageKey" TEXT,
  "structuredInvoiceId" TEXT,
  "error" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "InvoiceIssuanceRequest_ownerId_requestKey_key" ON "InvoiceIssuanceRequest"("ownerId", "requestKey");
CREATE INDEX "InvoiceIssuanceRequest_ownerId_status_updatedAt_idx" ON "InvoiceIssuanceRequest"("ownerId", "status", "updatedAt");

CREATE TABLE "VatPostingRecord" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "journalLineId" TEXT,
  "documentId" TEXT,
  "taxPoint" DATETIME NOT NULL,
  "jurisdiction" TEXT NOT NULL,
  "netBaseCents" INTEGER NOT NULL,
  "rateBasisPoints" INTEGER NOT NULL,
  "taxCents" INTEGER NOT NULL,
  "deductibleTaxCents" INTEGER NOT NULL,
  "grossCents" INTEGER NOT NULL,
  "outputTaxCents" INTEGER NOT NULL,
  "inputTaxCents" INTEGER NOT NULL,
  "ruleId" TEXT NOT NULL,
  "ruleVersion" INTEGER NOT NULL,
  "vatCase" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "returnBoxes" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VatPostingRecord_journalLineId_fkey" FOREIGN KEY ("journalLineId") REFERENCES "JournalLine" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "VatPostingRecord_journalLineId_key" ON "VatPostingRecord"("journalLineId");
CREATE UNIQUE INDEX "VatPostingRecord_ownerId_sourceId_key" ON "VatPostingRecord"("ownerId", "sourceId");
CREATE INDEX "VatPostingRecord_ownerId_taxPoint_idx" ON "VatPostingRecord"("ownerId", "taxPoint");
CREATE INDEX "VatPostingRecord_ownerId_documentId_idx" ON "VatPostingRecord"("ownerId", "documentId");

CREATE TABLE "VatReversalMarker" (
  "ownerId" TEXT NOT NULL,
  "marker" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("ownerId", "marker")
);

CREATE TABLE "TaxWorkflowRecord" (
  "submissionId" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "period" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  "receipt" TEXT,
  "correctsId" TEXT,
  "actionReservation" TEXT,
  "deadline" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "TaxWorkflowRecord_ownerId_idempotencyKey_key" ON "TaxWorkflowRecord"("ownerId", "idempotencyKey");
CREATE INDEX "TaxWorkflowRecord_ownerId_kind_period_updatedAt_idx" ON "TaxWorkflowRecord"("ownerId", "kind", "period", "updatedAt");
CREATE INDEX "TaxWorkflowRecord_ownerId_correctsId_idx" ON "TaxWorkflowRecord"("ownerId", "correctsId");

CREATE TABLE "TaxSubmissionRequest" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "requestKey" TEXT NOT NULL,
    "datasetHash" TEXT NOT NULL,
    "filingKey" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PROCESSING',
  "submissionId" TEXT,
  "error" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "TaxSubmissionRequest_ownerId_requestKey_key" ON "TaxSubmissionRequest"("ownerId", "requestKey");
CREATE UNIQUE INDEX "TaxSubmissionRequest_filingKey_key" ON "TaxSubmissionRequest"("filingKey");
CREATE INDEX "TaxSubmissionRequest_ownerId_createdAt_idx" ON "TaxSubmissionRequest"("ownerId", "createdAt");

CREATE TABLE "TaxAdjustmentRecord" (
  "id" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "year" INTEGER NOT NULL,
  "ruleVersion" TEXT NOT NULL,
  "field" TEXT NOT NULL,
  "layer" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "sourceDocumentIds" TEXT NOT NULL,
  "legalBasis" TEXT NOT NULL,
  "treatment" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("ownerId", "id")
);
CREATE INDEX "TaxAdjustmentRecord_ownerId_year_idx" ON "TaxAdjustmentRecord"("ownerId", "year");

CREATE TABLE "TaxDatasetPreparationRecord" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "period" TEXT NOT NULL,
    "datasetHash" TEXT NOT NULL,
    "sourcePayload" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "TaxDatasetPreparationRecord_ownerId_datasetHash_key" ON "TaxDatasetPreparationRecord"("ownerId", "datasetHash");
CREATE INDEX "TaxDatasetPreparationRecord_ownerId_kind_period_createdAt_idx" ON "TaxDatasetPreparationRecord"("ownerId", "kind", "period", "createdAt");

CREATE TABLE "TaxAssessmentRecord" (
  "id" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "period" TEXT NOT NULL,
  "assessedAmountCents" INTEGER NOT NULL,
  "receivedAt" DATETIME NOT NULL,
  "documentHash" TEXT NOT NULL,
  "declarationSubmissionId" TEXT NOT NULL,
  "differenceCents" INTEGER NOT NULL,
  "needsReview" BOOLEAN NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("ownerId", "id")
);
CREATE INDEX "TaxAssessmentRecord_ownerId_kind_period_idx" ON "TaxAssessmentRecord"("ownerId", "kind", "period");
CREATE INDEX "TaxAssessmentRecord_ownerId_declarationSubmissionId_idx" ON "TaxAssessmentRecord"("ownerId", "declarationSubmissionId");
