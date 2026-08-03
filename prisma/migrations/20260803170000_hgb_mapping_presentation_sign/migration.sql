ALTER TABLE "AccountMappingVersion" ADD COLUMN "presentationSign" INTEGER NOT NULL DEFAULT 1;

CREATE TRIGGER "AccountMappingVersion_presentation_sign_insert"
BEFORE INSERT ON "AccountMappingVersion"
WHEN NEW."presentationSign" NOT IN (-1, 1)
BEGIN
  SELECT RAISE(ABORT, 'Account mapping presentation sign must be -1 or 1');
END;

CREATE TRIGGER "AccountMappingVersion_presentation_sign_update"
BEFORE UPDATE OF "presentationSign" ON "AccountMappingVersion"
WHEN NEW."presentationSign" NOT IN (-1, 1)
BEGIN
  SELECT RAISE(ABORT, 'Account mapping presentation sign must be -1 or 1');
END;
