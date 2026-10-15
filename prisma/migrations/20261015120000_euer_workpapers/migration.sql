CREATE TABLE "EuerRevision" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "year" INTEGER NOT NULL CHECK ("year" IN (2025, 2026)),
  "version" INTEGER NOT NULL CHECK ("version" > 0),
  "requestKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "profileChecksum" TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  "createdBy" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("ownerId", "year") REFERENCES "FiscalYear" ("ownerId", "year") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "EuerRevision_ownerId_year_version_key" ON "EuerRevision"("ownerId", "year", "version");
CREATE UNIQUE INDEX "EuerRevision_ownerId_requestKey_key" ON "EuerRevision"("ownerId", "requestKey");
CREATE TRIGGER "EuerRevision_no_update" BEFORE UPDATE ON "EuerRevision"
BEGIN SELECT RAISE(ABORT, 'EÜR revisions are immutable'); END;
CREATE TRIGGER "EuerRevision_no_delete" BEFORE DELETE ON "EuerRevision"
BEGIN SELECT RAISE(ABORT, 'EÜR revisions are immutable'); END;
CREATE TRIGGER "EuerRevision_open_year" BEFORE INSERT ON "EuerRevision"
WHEN NOT EXISTS (SELECT 1 FROM "FiscalYear" WHERE "ownerId" = NEW."ownerId" AND "year" = NEW."year" AND "status" = 'OPEN')
BEGIN SELECT RAISE(ABORT, 'EÜR requires an open fiscal year'); END;
