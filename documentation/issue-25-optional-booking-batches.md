# Optional booking batches (#25)

The booking form offers two explicit choices: **Post now** (the initial choice) and **Save to booking batches**. Saving for review creates a durable draft without changing the journal or reports. The existing tenant/year-scoped batch workspace supports review, editing and explicit posting.

Both choices use the existing draft and journal services. Immediate posting saves the draft and then posts its ID and reviewed version. If the posting response is lost, the browser retains that reference per tenant and fiscal year. Reloading offers an explicit retry of the same draft or continued review in the batch workspace. Retrying a posted draft returns its existing entry. A failed draft-creation response is reported as unconfirmed and directs the user to check the batch list before saving again.

If recovery storage is unavailable, immediate posting stops after saving the draft. The user can continue in the durable batch workspace. Workflow consequences are associated with the radio controls for screen readers, and mobile amount fields retain visible debit/credit labels.

## Posting and permission boundaries

- ADMIN and ACCOUNTANT can save, edit and post. READ_ONLY users cannot mutate either route. Every request derives its tenant and actor from the authenticated session.
- One draft represents one balanced journal entry, which can contain multiple split lines. Entries in the batch list are reviewed and posted individually. This change adds no bulk-post operation or multi-entry transaction: one entry's success does not imply that other drafts were posted. All lines, VAT persistence and the journal posting audit record for an individual entry commit together through the existing ledger transaction.
- Posting checks the reviewed version and atomically claims that version. A concurrent edit cannot silently replace the posting that was reviewed. Existing callers that omit a version remain compatible; the claim still checks the version read by the server.
- The existing open-period, active account, document ownership, balancing, VAT and immutable-journal checks remain authoritative. Posting failures preserve the draft for review. Posted drafts cannot be revised.
- Draft finalization retains the existing recoverable posting protocol: a journal entry can commit before the final draft audit transition, and retry reconciles it using the draft's unique external key.

## Compatibility and integration

`POST /api/booking-records` still creates a draft. Existing integrations and tests that explicitly use the two-stage API retain that behavior. The booking form composes the two API calls when the user chooses immediate posting. No schema migration is required.

PR #56 / issue #49 owns the separate authenticated journal-audit actor correction. This change continues passing the authenticated actor to the existing draft service and does not replace that PR's ledger service contract. Retain #49's actor propagation when combining changes.

## Verification

- Vitest covers draft-only requests, stable posting retries, response errors, recovery scoping/storage failures, version checks, tenant/year isolation, mutation authorization, rejected posting rollback and posted-entry immutability.
- `playwright.booking-batches.config.ts` runs the real save/review/edit/post journey, lost committed-response/reload/retry, unavailable recovery storage and the existing primary accounting UI checks with page models. It owns port 3225, `booking-batches-playwright.db` and `.playwright/booking-batches-documents`; it refuses to reuse another server.
- Screenshots cover the choice and recovery states at desktop and 390 px mobile width. Layout is reviewed visually, without layout assertions.
