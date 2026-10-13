-- Nullable leases preserve completed reviews and allow legacy PROCESSING rows
-- to be reclaimed explicitly by the authenticated extraction workflow.
ALTER TABLE "DocumentExtraction" ADD COLUMN "attemptId" TEXT;
ALTER TABLE "DocumentExtraction" ADD COLUMN "leaseExpiresAt" DATETIME;
