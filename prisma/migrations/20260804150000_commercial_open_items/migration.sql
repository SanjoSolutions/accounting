CREATE UNIQUE INDEX "FiscalYear_ownerId_id_key" ON "FiscalYear"("ownerId", "id");
CREATE UNIQUE INDEX "DocumentRecord_ownerId_id_key" ON "DocumentRecord"("ownerId", "id");
CREATE UNIQUE INDEX "StructuredInvoice_ownerId_id_key" ON "StructuredInvoice"("ownerId", "id");

PRAGMA foreign_keys=OFF;
CREATE TABLE "JournalEntry_commercial_new" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "sequenceNumber" INTEGER NOT NULL,
  "bookingDate" DATETIME NOT NULL,
  "sourcePostingDate" DATETIME,
  "sourceJournalDate" DATETIME,
  "sourcePeriod" INTEGER,
  "documentNumber" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'MANUAL',
  "state" TEXT NOT NULL DEFAULT 'POSTED',
  "entryDate" DATETIME DEFAULT CURRENT_TIMESTAMP,
  "lateReason" TEXT,
  "reversalOfId" TEXT,
  "replacementOfId" TEXT,
  "externalKey" TEXT,
  "fiscalYearId" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "JournalEntry_ownerId_fiscalYearId_fkey" FOREIGN KEY ("ownerId", "fiscalYearId") REFERENCES "FiscalYear" ("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "JournalEntry_commercial_new" (
  "id", "ownerId", "sequenceNumber", "bookingDate", "sourcePostingDate", "sourceJournalDate", "sourcePeriod",
  "documentNumber", "description", "source", "state", "entryDate", "lateReason", "reversalOfId",
  "replacementOfId", "externalKey", "fiscalYearId", "createdAt"
)
SELECT j."id", fy."ownerId", j."sequenceNumber", j."bookingDate", j."sourcePostingDate", j."sourceJournalDate", j."sourcePeriod",
  j."documentNumber", j."description", j."source", j."state", j."entryDate", j."lateReason", j."reversalOfId",
  j."replacementOfId", j."externalKey", j."fiscalYearId", j."createdAt"
FROM "JournalEntry" j
JOIN "FiscalYear" fy ON fy."id" = j."fiscalYearId";
DROP TABLE "JournalEntry";
ALTER TABLE "JournalEntry_commercial_new" RENAME TO "JournalEntry";
CREATE UNIQUE INDEX "JournalEntry_externalKey_key" ON "JournalEntry"("externalKey");
CREATE UNIQUE INDEX "JournalEntry_reversalOfId_key" ON "JournalEntry"("reversalOfId");
CREATE UNIQUE INDEX "JournalEntry_replacementOfId_key" ON "JournalEntry"("replacementOfId");
CREATE UNIQUE INDEX "JournalEntry_fiscalYearId_sequenceNumber_key" ON "JournalEntry"("fiscalYearId", "sequenceNumber");
CREATE UNIQUE INDEX "JournalEntry_fiscalYearId_documentNumber_key" ON "JournalEntry"("fiscalYearId", "documentNumber");
CREATE UNIQUE INDEX "JournalEntry_ownerId_id_key" ON "JournalEntry"("ownerId", "id");
CREATE INDEX "JournalEntry_bookingDate_idx" ON "JournalEntry"("bookingDate");
PRAGMA foreign_keys=ON;

CREATE TABLE "BusinessPartner" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "partnerNumber" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "contactName" TEXT,
  "email" TEXT,
  "street" TEXT,
  "houseNumber" TEXT,
  "postalCode" TEXT,
  "city" TEXT,
  "countryCode" TEXT NOT NULL DEFAULT 'DE',
  "vatId" TEXT,
  "taxId" TEXT,
  "paymentTermDays" INTEGER NOT NULL DEFAULT 14,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ("role" IN ('CUSTOMER','SUPPLIER','BOTH')),
  CHECK ("paymentTermDays" BETWEEN 0 AND 3650),
  CHECK (length("countryCode") = 2 AND "countryCode" = upper("countryCode"))
);
CREATE UNIQUE INDEX "BusinessPartner_ownerId_id_key" ON "BusinessPartner"("ownerId", "id");
CREATE UNIQUE INDEX "BusinessPartner_ownerId_partnerNumber_key" ON "BusinessPartner"("ownerId", "partnerNumber");
CREATE INDEX "BusinessPartner_ownerId_name_idx" ON "BusinessPartner"("ownerId", "name");
CREATE INDEX "BusinessPartner_ownerId_vatId_idx" ON "BusinessPartner"("ownerId", "vatId");

CREATE TABLE "CommercialDocument" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "businessPartnerId" TEXT NOT NULL,
  "structuredInvoiceId" TEXT,
  "evidenceDocumentId" TEXT,
  "postingJournalEntryId" TEXT,
  "correctsId" TEXT,
  "direction" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "documentNumber" TEXT,
  "documentIdentityKey" TEXT,
  "issueDate" DATETIME,
  "serviceDate" DATETIME NOT NULL,
  "dueDate" DATETIME NOT NULL,
  "description" TEXT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'EUR',
  "netAmountCents" INTEGER NOT NULL,
  "taxAmountCents" INTEGER NOT NULL,
  "grossAmountCents" INTEGER NOT NULL,
  "payableAmountCents" INTEGER NOT NULL,
  "counterpartySnapshot" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CommercialDocument_ownerId_businessPartnerId_fkey" FOREIGN KEY ("ownerId", "businessPartnerId") REFERENCES "BusinessPartner" ("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CommercialDocument_ownerId_structuredInvoiceId_fkey" FOREIGN KEY ("ownerId", "structuredInvoiceId") REFERENCES "StructuredInvoice" ("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CommercialDocument_ownerId_evidenceDocumentId_fkey" FOREIGN KEY ("ownerId", "evidenceDocumentId") REFERENCES "DocumentRecord" ("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CommercialDocument_ownerId_postingJournalEntryId_fkey" FOREIGN KEY ("ownerId", "postingJournalEntryId") REFERENCES "JournalEntry" ("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CommercialDocument_ownerId_correctsId_fkey" FOREIGN KEY ("ownerId", "correctsId") REFERENCES "CommercialDocument" ("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CHECK ("direction" IN ('RECEIVABLE','PAYABLE')),
  CHECK ("kind" IN ('INVOICE','CREDIT_NOTE')),
  CHECK ("status" IN ('DRAFT','FINAL','POSTED','CORRECTED')),
  CHECK (length("currency") = 3 AND "currency" = upper("currency")),
  CHECK ("netAmountCents" >= 0 AND "taxAmountCents" >= 0 AND "grossAmountCents" = "netAmountCents" + "taxAmountCents" AND "payableAmountCents" >= 0),
  CHECK (date("dueDate") >= date("serviceDate")),
  CHECK ("issueDate" IS NULL OR date("dueDate") >= date("issueDate"))
);
CREATE UNIQUE INDEX "CommercialDocument_ownerId_id_key" ON "CommercialDocument"("ownerId", "id");
CREATE UNIQUE INDEX "CommercialDocument_ownerId_direction_documentIdentityKey_key" ON "CommercialDocument"("ownerId", "direction", "documentIdentityKey");
CREATE UNIQUE INDEX "CommercialDocument_ownerId_structuredInvoiceId_key" ON "CommercialDocument"("ownerId", "structuredInvoiceId");
CREATE INDEX "CommercialDocument_ownerId_businessPartnerId_serviceDate_idx" ON "CommercialDocument"("ownerId", "businessPartnerId", "serviceDate");
CREATE INDEX "CommercialDocument_ownerId_status_dueDate_idx" ON "CommercialDocument"("ownerId", "status", "dueDate");
CREATE INDEX "CommercialDocument_ownerId_postingJournalEntryId_idx" ON "CommercialDocument"("ownerId", "postingJournalEntryId");
CREATE INDEX "CommercialDocument_ownerId_correctsId_idx" ON "CommercialDocument"("ownerId", "correctsId");

CREATE TABLE "OpenItem" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "commercialDocumentId" TEXT NOT NULL,
  "side" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  "originalAmountCents" INTEGER NOT NULL,
  "allocatedAmountCents" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OpenItem_ownerId_commercialDocumentId_fkey" FOREIGN KEY ("ownerId", "commercialDocumentId") REFERENCES "CommercialDocument" ("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CHECK ("side" IN ('DEBIT','CREDIT')),
  CHECK (length("currency") = 3 AND "currency" = upper("currency")),
  CHECK ("originalAmountCents" > 0 AND "allocatedAmountCents" BETWEEN 0 AND "originalAmountCents"),
  CHECK ("status" IN ('OPEN','PARTIAL','SETTLED'))
);
CREATE UNIQUE INDEX "OpenItem_ownerId_id_key" ON "OpenItem"("ownerId", "id");
CREATE UNIQUE INDEX "OpenItem_ownerId_commercialDocumentId_key" ON "OpenItem"("ownerId", "commercialDocumentId");
CREATE INDEX "OpenItem_ownerId_status_updatedAt_idx" ON "OpenItem"("ownerId", "status", "updatedAt");

CREATE TABLE "PaymentSettlement" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "businessPartnerId" TEXT NOT NULL,
  "journalEntryId" TEXT NOT NULL,
  "direction" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "allocatedAmountCents" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'UNALLOCATED',
  "version" INTEGER NOT NULL DEFAULT 1,
  "occurredOn" DATETIME NOT NULL,
  "createdBy" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentSettlement_ownerId_businessPartnerId_fkey" FOREIGN KEY ("ownerId", "businessPartnerId") REFERENCES "BusinessPartner" ("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PaymentSettlement_ownerId_journalEntryId_fkey" FOREIGN KEY ("ownerId", "journalEntryId") REFERENCES "JournalEntry" ("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CHECK ("direction" IN ('RECEIPT','DISBURSEMENT')),
  CHECK (length("currency") = 3 AND "currency" = upper("currency")),
  CHECK ("amountCents" > 0 AND "allocatedAmountCents" BETWEEN 0 AND "amountCents"),
  CHECK ("status" IN ('UNALLOCATED','PARTIAL','ALLOCATED'))
);
CREATE UNIQUE INDEX "PaymentSettlement_ownerId_id_key" ON "PaymentSettlement"("ownerId", "id");
CREATE UNIQUE INDEX "PaymentSettlement_ownerId_journalEntryId_key" ON "PaymentSettlement"("ownerId", "journalEntryId");
CREATE INDEX "PaymentSettlement_ownerId_businessPartnerId_status_occurredOn_idx" ON "PaymentSettlement"("ownerId", "businessPartnerId", "status", "occurredOn");

CREATE TABLE "SettlementAllocation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "openItemId" TEXT NOT NULL,
  "settlementId" TEXT NOT NULL,
  "journalEntryId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "requestKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "reversesAllocationId" TEXT,
  "effectiveDate" DATETIME NOT NULL,
  "createdBy" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SettlementAllocation_ownerId_openItemId_fkey" FOREIGN KEY ("ownerId", "openItemId") REFERENCES "OpenItem" ("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SettlementAllocation_ownerId_settlementId_fkey" FOREIGN KEY ("ownerId", "settlementId") REFERENCES "PaymentSettlement" ("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SettlementAllocation_ownerId_journalEntryId_fkey" FOREIGN KEY ("ownerId", "journalEntryId") REFERENCES "JournalEntry" ("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SettlementAllocation_ownerId_reversesAllocationId_fkey" FOREIGN KEY ("ownerId", "reversesAllocationId") REFERENCES "SettlementAllocation" ("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CHECK (("kind" = 'APPLY' AND "amountCents" > 0 AND "reversesAllocationId" IS NULL) OR ("kind" = 'REVERSAL' AND "amountCents" < 0 AND "reversesAllocationId" IS NOT NULL))
);
CREATE UNIQUE INDEX "SettlementAllocation_ownerId_id_key" ON "SettlementAllocation"("ownerId", "id");
CREATE UNIQUE INDEX "SettlementAllocation_ownerId_requestKey_key" ON "SettlementAllocation"("ownerId", "requestKey");
CREATE UNIQUE INDEX "SettlementAllocation_ownerId_reversesAllocationId_key" ON "SettlementAllocation"("ownerId", "reversesAllocationId");
CREATE INDEX "SettlementAllocation_ownerId_openItemId_createdAt_idx" ON "SettlementAllocation"("ownerId", "openItemId", "createdAt");
CREATE INDEX "SettlementAllocation_ownerId_settlementId_createdAt_idx" ON "SettlementAllocation"("ownerId", "settlementId", "createdAt");
CREATE INDEX "SettlementAllocation_ownerId_journalEntryId_idx" ON "SettlementAllocation"("ownerId", "journalEntryId");

CREATE TRIGGER "CommercialDocument_require_final_evidence"
BEFORE UPDATE ON "CommercialDocument"
WHEN NEW."status" != 'DRAFT' AND (NEW."documentNumber" IS NULL OR NEW."documentIdentityKey" IS NULL OR NEW."issueDate" IS NULL OR NEW."evidenceDocumentId" IS NULL OR NEW."counterpartySnapshot" IS NULL)
BEGIN SELECT RAISE(ABORT, 'final commercial documents require identity, dates, evidence and counterparty snapshot'); END;
CREATE TRIGGER "CommercialDocument_require_final_evidence_insert"
BEFORE INSERT ON "CommercialDocument"
WHEN NEW."status" != 'DRAFT' AND (NEW."documentNumber" IS NULL OR NEW."documentIdentityKey" IS NULL OR NEW."issueDate" IS NULL OR NEW."evidenceDocumentId" IS NULL OR NEW."counterpartySnapshot" IS NULL)
BEGIN SELECT RAISE(ABORT, 'final commercial documents require identity, dates, evidence and counterparty snapshot'); END;
CREATE TRIGGER "CommercialDocument_immutable_final"
BEFORE UPDATE OF "ownerId", "businessPartnerId", "structuredInvoiceId", "evidenceDocumentId", "correctsId", "direction", "kind", "documentNumber", "documentIdentityKey", "issueDate", "serviceDate", "dueDate", "description", "currency", "netAmountCents", "taxAmountCents", "grossAmountCents", "payableAmountCents", "counterpartySnapshot" ON "CommercialDocument"
WHEN OLD."status" != 'DRAFT'
BEGIN SELECT RAISE(ABORT, 'final commercial document identity and amounts are immutable'); END;
CREATE TRIGGER "CommercialDocument_posting_link_transition"
BEFORE UPDATE OF "postingJournalEntryId" ON "CommercialDocument"
WHEN OLD."status" != 'DRAFT' AND NOT (OLD."status"='FINAL' AND NEW."status"='POSTED' AND OLD."postingJournalEntryId" IS NULL AND NEW."postingJournalEntryId" IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'posting journal can only be attached while posting a final document'); END;
CREATE TRIGGER "CommercialDocument_prevent_final_delete"
BEFORE DELETE ON "CommercialDocument" WHEN OLD."status" != 'DRAFT'
BEGIN SELECT RAISE(ABORT, 'final commercial documents cannot be deleted'); END;
CREATE TRIGGER "CommercialDocument_status_transition"
BEFORE UPDATE OF "status" ON "CommercialDocument"
WHEN NOT ((OLD."status"='DRAFT' AND NEW."status" IN ('FINAL','POSTED')) OR (OLD."status"='FINAL' AND NEW."status"='POSTED') OR (OLD."status"='POSTED' AND NEW."status"='CORRECTED'))
BEGIN SELECT RAISE(ABORT, 'invalid commercial document status transition'); END;
CREATE TRIGGER "CommercialDocument_structured_invoice_consistency"
BEFORE UPDATE ON "CommercialDocument" WHEN NEW."structuredInvoiceId" IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM "StructuredInvoice" si
    WHERE si."ownerId"=NEW."ownerId" AND si."id"=NEW."structuredInvoiceId"
      AND si."documentId"=NEW."evidenceDocumentId"
      AND si."invoiceNumber"=NEW."documentNumber"
      AND ((si."direction"='OUTGOING' AND NEW."direction"='RECEIVABLE') OR (si."direction"='INCOMING' AND NEW."direction"='PAYABLE'))
      AND date(si."issueDate")=date(NEW."issueDate")
      AND json_extract(si."data", '$.currency')=NEW."currency"
      AND json_extract(si."data", '$.netAmountCents')=NEW."netAmountCents"
      AND json_extract(si."data", '$.taxAmountCents')=NEW."taxAmountCents"
      AND json_extract(si."data", '$.grossAmountCents')=NEW."grossAmountCents"
  ) THEN RAISE(ABORT, 'structured invoice and commercial document facts differ') END;
END;
CREATE TRIGGER "CommercialDocument_structured_invoice_consistency_insert"
BEFORE INSERT ON "CommercialDocument" WHEN NEW."structuredInvoiceId" IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM "StructuredInvoice" si
    WHERE si."ownerId"=NEW."ownerId" AND si."id"=NEW."structuredInvoiceId"
      AND si."documentId"=NEW."evidenceDocumentId"
      AND si."invoiceNumber"=NEW."documentNumber"
      AND ((si."direction"='OUTGOING' AND NEW."direction"='RECEIVABLE') OR (si."direction"='INCOMING' AND NEW."direction"='PAYABLE'))
      AND date(si."issueDate")=date(NEW."issueDate")
      AND json_extract(si."data", '$.currency')=NEW."currency"
      AND json_extract(si."data", '$.netAmountCents')=NEW."netAmountCents"
      AND json_extract(si."data", '$.taxAmountCents')=NEW."taxAmountCents"
      AND json_extract(si."data", '$.grossAmountCents')=NEW."grossAmountCents"
  ) THEN RAISE(ABORT, 'structured invoice and commercial document facts differ') END;
END;

CREATE TRIGGER "SettlementAllocation_validate_insert"
BEFORE INSERT ON "SettlementAllocation"
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM "JournalEntry" j WHERE j."id"=NEW."journalEntryId" AND j."ownerId"=NEW."ownerId" AND j."state"='POSTED') THEN RAISE(ABORT,'settlement journal must be a posted tenant journal entry') END;
  SELECT CASE WHEN NEW."kind"='APPLY' AND NOT EXISTS (
    SELECT 1 FROM "PaymentSettlement" p
    JOIN "OpenItem" o ON o."ownerId"=NEW."ownerId" AND o."id"=NEW."openItemId"
    JOIN "CommercialDocument" d ON d."ownerId"=o."ownerId" AND d."id"=o."commercialDocumentId"
    WHERE p."ownerId"=NEW."ownerId" AND p."id"=NEW."settlementId" AND p."journalEntryId"=NEW."journalEntryId"
      AND p."businessPartnerId"=d."businessPartnerId" AND p."currency"=o."currency"
      AND ((p."direction"='RECEIPT' AND d."direction"='RECEIVABLE') OR (p."direction"='DISBURSEMENT' AND d."direction"='PAYABLE'))
      AND p."allocatedAmountCents"+NEW."amountCents"<=p."amountCents"
  ) THEN RAISE(ABORT,'payment settlement scope or available amount is invalid') END;
  SELECT CASE WHEN NEW."kind"='APPLY' AND (SELECT o."allocatedAmountCents" + NEW."amountCents" > o."originalAmountCents" FROM "OpenItem" o WHERE o."id"=NEW."openItemId" AND o."ownerId"=NEW."ownerId") THEN RAISE(ABORT,'settlement exceeds open amount') END;
  SELECT CASE WHEN NEW."kind"='REVERSAL' AND NOT EXISTS (SELECT 1 FROM "SettlementAllocation" prior WHERE prior."id"=NEW."reversesAllocationId" AND prior."ownerId"=NEW."ownerId" AND prior."openItemId"=NEW."openItemId" AND prior."settlementId"=NEW."settlementId" AND prior."kind"='APPLY' AND NEW."amountCents"=-prior."amountCents" AND NOT EXISTS (SELECT 1 FROM "SettlementAllocation" r WHERE r."ownerId"=NEW."ownerId" AND r."reversesAllocationId"=prior."id")) THEN RAISE(ABORT,'invalid settlement reversal') END;
  SELECT CASE WHEN (SELECT o."allocatedAmountCents" + NEW."amountCents" < 0 FROM "OpenItem" o WHERE o."id"=NEW."openItemId" AND o."ownerId"=NEW."ownerId") THEN RAISE(ABORT,'settlement reversal exceeds allocated amount') END;
END;
CREATE TRIGGER "SettlementAllocation_apply_to_open_item"
AFTER INSERT ON "SettlementAllocation"
BEGIN
  UPDATE "OpenItem"
  SET "allocatedAmountCents"="allocatedAmountCents"+NEW."amountCents",
      "status"=CASE WHEN "allocatedAmountCents"+NEW."amountCents"=0 THEN 'OPEN' WHEN "allocatedAmountCents"+NEW."amountCents"="originalAmountCents" THEN 'SETTLED' ELSE 'PARTIAL' END,
      "version"="version"+1,
      "updatedAt"=CURRENT_TIMESTAMP
  WHERE "id"=NEW."openItemId" AND "ownerId"=NEW."ownerId";
  UPDATE "PaymentSettlement"
  SET "allocatedAmountCents"="allocatedAmountCents"+NEW."amountCents",
      "status"=CASE WHEN "allocatedAmountCents"+NEW."amountCents"=0 THEN 'UNALLOCATED' WHEN "allocatedAmountCents"+NEW."amountCents"="amountCents" THEN 'ALLOCATED' ELSE 'PARTIAL' END,
      "version"="version"+1,
      "updatedAt"=CURRENT_TIMESTAMP
  WHERE "id"=NEW."settlementId" AND "ownerId"=NEW."ownerId";
END;
CREATE TRIGGER "SettlementAllocation_immutable_update" BEFORE UPDATE ON "SettlementAllocation" BEGIN SELECT RAISE(ABORT,'settlement allocations are immutable'); END;
CREATE TRIGGER "SettlementAllocation_immutable_delete" BEFORE DELETE ON "SettlementAllocation" BEGIN SELECT RAISE(ABORT,'settlement allocations are immutable'); END;
CREATE TRIGGER "OpenItem_identity_immutable" BEFORE UPDATE OF "ownerId","commercialDocumentId","side","currency","originalAmountCents" ON "OpenItem" BEGIN SELECT RAISE(ABORT,'open item identity is immutable'); END;
CREATE TRIGGER "OpenItem_derived_balance_guard"
BEFORE UPDATE OF "allocatedAmountCents","status","version" ON "OpenItem"
WHEN NEW."allocatedAmountCents" != COALESCE((SELECT SUM(a."amountCents") FROM "SettlementAllocation" a WHERE a."ownerId"=NEW."ownerId" AND a."openItemId"=NEW."id"),0)
  OR NEW."status" != CASE WHEN NEW."allocatedAmountCents"=0 THEN 'OPEN' WHEN NEW."allocatedAmountCents"=NEW."originalAmountCents" THEN 'SETTLED' ELSE 'PARTIAL' END
  OR NEW."version" != OLD."version"+1
BEGIN SELECT RAISE(ABORT,'open item balance is derived from immutable allocations'); END;
CREATE TRIGGER "PaymentSettlement_identity_immutable" BEFORE UPDATE OF "ownerId","businessPartnerId","journalEntryId","direction","currency","amountCents","occurredOn","createdBy" ON "PaymentSettlement" BEGIN SELECT RAISE(ABORT,'payment settlement identity is immutable'); END;
CREATE TRIGGER "PaymentSettlement_prevent_delete" BEFORE DELETE ON "PaymentSettlement" BEGIN SELECT RAISE(ABORT,'payment settlements cannot be deleted'); END;
CREATE TRIGGER "PaymentSettlement_derived_balance_guard"
BEFORE UPDATE OF "allocatedAmountCents","status","version" ON "PaymentSettlement"
WHEN NEW."allocatedAmountCents" != COALESCE((SELECT SUM(a."amountCents") FROM "SettlementAllocation" a WHERE a."ownerId"=NEW."ownerId" AND a."settlementId"=NEW."id"),0)
  OR NEW."status" != CASE WHEN NEW."allocatedAmountCents"=0 THEN 'UNALLOCATED' WHEN NEW."allocatedAmountCents"=NEW."amountCents" THEN 'ALLOCATED' ELSE 'PARTIAL' END
  OR NEW."version" != OLD."version"+1
BEGIN SELECT RAISE(ABORT,'payment settlement balance is derived from immutable allocations'); END;
