CREATE UNIQUE INDEX "EBalanceSubmission_one_active_submission_per_year"
ON "EBalanceSubmission"("ownerId", "year")
WHERE "kind" = 'SUBMISSION' AND "status" IN ('PENDING', 'UNKNOWN', 'ACCEPTED');
