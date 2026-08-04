CREATE TABLE "ReceivablesReminder" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "openItemId" TEXT NOT NULL,
  "level" INTEGER NOT NULL,
  "requestKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "issuedOn" DATETIME NOT NULL,
  "paymentDueDate" DATETIME NOT NULL,
  "originalDueDate" DATETIME NOT NULL,
  "remainingAmountCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "invoiceNumber" TEXT NOT NULL,
  "partnerSnapshot" TEXT NOT NULL,
  "issuerSnapshot" TEXT NOT NULL,
  "printableHtml" TEXT NOT NULL,
  "createdBy" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReceivablesReminder_ownerId_openItemId_fkey" FOREIGN KEY ("ownerId", "openItemId") REFERENCES "OpenItem" ("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ReceivablesReminder_ownerId_id_key" ON "ReceivablesReminder"("ownerId", "id");
CREATE UNIQUE INDEX "ReceivablesReminder_ownerId_requestKey_key" ON "ReceivablesReminder"("ownerId", "requestKey");
CREATE UNIQUE INDEX "ReceivablesReminder_ownerId_openItemId_level_key" ON "ReceivablesReminder"("ownerId", "openItemId", "level");
CREATE INDEX "ReceivablesReminder_ownerId_issuedOn_idx" ON "ReceivablesReminder"("ownerId", "issuedOn");

CREATE TABLE "ReceivablesReminderCancellation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "reminderId" TEXT NOT NULL,
  "requestKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "cancelledOn" DATETIME NOT NULL,
  "reason" TEXT NOT NULL,
  "createdBy" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReceivablesReminderCancellation_ownerId_reminderId_fkey" FOREIGN KEY ("ownerId", "reminderId") REFERENCES "ReceivablesReminder" ("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ReceivablesReminderCancellation_ownerId_id_key" ON "ReceivablesReminderCancellation"("ownerId", "id");
CREATE UNIQUE INDEX "ReceivablesReminderCancellation_ownerId_reminderId_key" ON "ReceivablesReminderCancellation"("ownerId", "reminderId");
CREATE UNIQUE INDEX "ReceivablesReminderCancellation_ownerId_requestKey_key" ON "ReceivablesReminderCancellation"("ownerId", "requestKey");
CREATE INDEX "ReceivablesReminderCancellation_ownerId_cancelledOn_idx" ON "ReceivablesReminderCancellation"("ownerId", "cancelledOn");

CREATE TRIGGER "ReceivablesReminder_validate_insert" BEFORE INSERT ON "ReceivablesReminder" BEGIN
  SELECT CASE WHEN NEW."level" != COALESCE((SELECT MAX("level") + 1 FROM "ReceivablesReminder" WHERE "ownerId" = NEW."ownerId" AND "openItemId" = NEW."openItemId"), 1) THEN RAISE(ABORT, 'Reminder level must be sequential') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM "OpenItem" oi JOIN "CommercialDocument" cd ON cd."ownerId" = oi."ownerId" AND cd."id" = oi."commercialDocumentId"
    WHERE oi."ownerId" = NEW."ownerId" AND oi."id" = NEW."openItemId" AND oi."status" IN ('OPEN','PARTIAL')
      AND oi."originalAmountCents" - oi."allocatedAmountCents" = NEW."remainingAmountCents" AND NEW."remainingAmountCents" > 0
      AND cd."direction" = 'RECEIVABLE' AND cd."kind" = 'INVOICE' AND cd."status" IN ('FINAL','POSTED') AND cd."dueDate" < NEW."issuedOn"
  ) THEN RAISE(ABORT, 'Reminder is not eligible') END;
END;
CREATE TRIGGER "ReceivablesReminder_immutable_update" BEFORE UPDATE ON "ReceivablesReminder" BEGIN SELECT RAISE(ABORT, 'Receivables reminders are immutable'); END;
CREATE TRIGGER "ReceivablesReminder_immutable_delete" BEFORE DELETE ON "ReceivablesReminder" BEGIN SELECT RAISE(ABORT, 'Receivables reminders are immutable'); END;
CREATE TRIGGER "ReceivablesReminderCancellation_immutable_update" BEFORE UPDATE ON "ReceivablesReminderCancellation" BEGIN SELECT RAISE(ABORT, 'Reminder cancellations are immutable'); END;
CREATE TRIGGER "ReceivablesReminderCancellation_immutable_delete" BEFORE DELETE ON "ReceivablesReminderCancellation" BEGIN SELECT RAISE(ABORT, 'Reminder cancellations are immutable'); END;
