-- Preserve the identity, local validation and first approval of retained reports.
-- Status remains separate from evidence (local approval is not official acceptance).
CREATE TRIGGER "EBalanceLifecycleReport_identity_immutable" BEFORE UPDATE ON "EBalanceLifecycleReport"
WHEN NEW."id" IS NOT OLD."id" OR NEW."createdBy" IS NOT OLD."createdBy" OR NEW."createdAt" IS NOT OLD."createdAt"
BEGIN SELECT RAISE(ABORT, 'E-Bilanz report identity is immutable'); END;

CREATE TRIGGER "EBalanceLifecycleReport_validation_immutable" BEFORE UPDATE ON "EBalanceLifecycleReport"
WHEN OLD."validationDiagnostics" IS NOT NULL AND (
  NEW."validationDiagnostics" IS NOT OLD."validationDiagnostics"
  OR NEW."validationEngine" IS NOT OLD."validationEngine"
  OR NEW."validatedAt" IS NOT OLD."validatedAt")
BEGIN SELECT RAISE(ABORT, 'E-Bilanz local validation evidence is immutable'); END;

CREATE TRIGGER "EBalanceLifecycleReport_approval_immutable" BEFORE UPDATE ON "EBalanceLifecycleReport"
WHEN (OLD."approvedAt" IS NOT NULL OR OLD."approvedBy" IS NOT NULL) AND (
  NEW."approvedAt" IS NOT OLD."approvedAt" OR NEW."approvedBy" IS NOT OLD."approvedBy")
BEGIN SELECT RAISE(ABORT, 'E-Bilanz report approval is immutable'); END;
