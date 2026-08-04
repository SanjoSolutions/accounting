CREATE TABLE "ReceivablesReminderDeliveryAttempt" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "reminderId" TEXT NOT NULL,
  "requestKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "recipient" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "attachmentFileName" TEXT NOT NULL,
  "attachmentHash" TEXT NOT NULL,
  "requestedBy" TEXT NOT NULL,
  "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReceivablesReminderDeliveryAttempt_ownerId_reminderId_fkey" FOREIGN KEY ("ownerId", "reminderId") REFERENCES "ReceivablesReminder" ("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ReceivablesReminderDeliveryAttempt_ownerId_id_key" ON "ReceivablesReminderDeliveryAttempt"("ownerId", "id");
CREATE UNIQUE INDEX "ReceivablesReminderDeliveryAttempt_ownerId_requestKey_key" ON "ReceivablesReminderDeliveryAttempt"("ownerId", "requestKey");
CREATE INDEX "ReceivablesReminderDeliveryAttempt_ownerId_reminderId_requestedAt_idx" ON "ReceivablesReminderDeliveryAttempt"("ownerId", "reminderId", "requestedAt");

CREATE TABLE "ReceivablesReminderDeliveryResult" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "attemptId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "providerMessageId" TEXT,
  "failureCode" TEXT,
  "failureMessage" TEXT,
  "respondedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReceivablesReminderDeliveryResult_ownerId_attemptId_fkey" FOREIGN KEY ("ownerId", "attemptId") REFERENCES "ReceivablesReminderDeliveryAttempt" ("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ReceivablesReminderDeliveryResult_valid_result" CHECK (
    ("status" = 'SENT' AND "providerMessageId" IS NOT NULL AND "failureCode" IS NULL AND "failureMessage" IS NULL) OR
    ("status" = 'FAILED' AND "providerMessageId" IS NULL AND "failureCode" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "ReceivablesReminderDeliveryResult_ownerId_id_key" ON "ReceivablesReminderDeliveryResult"("ownerId", "id");
CREATE UNIQUE INDEX "ReceivablesReminderDeliveryResult_ownerId_attemptId_key" ON "ReceivablesReminderDeliveryResult"("ownerId", "attemptId");
CREATE INDEX "ReceivablesReminderDeliveryResult_ownerId_status_respondedAt_idx" ON "ReceivablesReminderDeliveryResult"("ownerId", "status", "respondedAt");

CREATE TRIGGER "ReceivablesReminderDeliveryAttempt_validate_insert" BEFORE INSERT ON "ReceivablesReminderDeliveryAttempt" BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM "ReceivablesReminder" WHERE "ownerId" = NEW."ownerId" AND "id" = NEW."reminderId") THEN RAISE(ABORT, 'Reminder delivery tenant relation is invalid') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM "ReceivablesReminderCancellation" WHERE "ownerId" = NEW."ownerId" AND "reminderId" = NEW."reminderId") THEN RAISE(ABORT, 'Cancelled reminders cannot be delivered') END;
END;
CREATE TRIGGER "ReceivablesReminderDeliveryAttempt_immutable_update" BEFORE UPDATE ON "ReceivablesReminderDeliveryAttempt" BEGIN SELECT RAISE(ABORT, 'Reminder delivery attempts are immutable'); END;
CREATE TRIGGER "ReceivablesReminderDeliveryAttempt_immutable_delete" BEFORE DELETE ON "ReceivablesReminderDeliveryAttempt" BEGIN SELECT RAISE(ABORT, 'Reminder delivery attempts are immutable'); END;
CREATE TRIGGER "ReceivablesReminderDeliveryResult_immutable_update" BEFORE UPDATE ON "ReceivablesReminderDeliveryResult" BEGIN SELECT RAISE(ABORT, 'Reminder delivery results are immutable'); END;
CREATE TRIGGER "ReceivablesReminderDeliveryResult_immutable_delete" BEFORE DELETE ON "ReceivablesReminderDeliveryResult" BEGIN SELECT RAISE(ABORT, 'Reminder delivery results are immutable'); END;
CREATE TRIGGER "ReceivablesReminderCancellation_no_pending_delivery" BEFORE INSERT ON "ReceivablesReminderCancellation" BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM "ReceivablesReminderDeliveryAttempt" attempt
    LEFT JOIN "ReceivablesReminderDeliveryResult" result ON result."ownerId" = attempt."ownerId" AND result."attemptId" = attempt."id"
    WHERE attempt."ownerId" = NEW."ownerId" AND attempt."reminderId" = NEW."reminderId" AND result."id" IS NULL
  ) THEN RAISE(ABORT, 'A pending reminder delivery must finish before cancellation') END;
END;
