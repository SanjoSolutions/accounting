PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_BookingRecordEntry" ("id" TEXT NOT NULL PRIMARY KEY, "payload" TEXT NOT NULL);
INSERT INTO "new_BookingRecordEntry" ("id", "payload") SELECT "id", "payload" FROM "BookingRecordEntry";
DROP TABLE "BookingRecordEntry";
ALTER TABLE "new_BookingRecordEntry" RENAME TO "BookingRecordEntry";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
