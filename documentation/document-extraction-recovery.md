# Recovering interrupted document extraction

Reopen the retained document and select **Retry extraction** if extraction is
still processing after an interruption. The authenticated extraction POST
endpoint rejects active leases with HTTP 409 and their expiry time. After expiry,
the same action starts a new attempt against the retained bytes. No document
re-upload, deletion, database edit, or background cleanup job is needed.

Each attempt receives a random `attemptId` and a `leaseExpiresAt` covering the
configured parser timeout plus 30 seconds for persistence. The existing bounded
parser timeout remains unchanged. A worker can only finish its own still-active
lease; an expired or replaced worker receives HTTP 409 without writing state or
an audit event. Completed and confirmed results have no active lease.

Claim, recovery, completion, failure and confirmation each persist the state and
audit event in one database transaction. Audit failures propagate and roll back
both the row and audit chain head. An interrupted completion remains recoverable
after lease expiry; it is never mislabeled as a parser failure. Recovery uses
`DOCUMENT_EXTRACTION_RECOVERED` with the old/new attempt in the audit delta.

Deployment must stop old application workers before applying the additive lease
migration and starting the updated application: old code has no attempt fencing.
Legacy PROCESSING rows have NULL leases and can be retried immediately by the new
workflow. Other legacy states, including authoritative structured invoice reviews,
are preserved. The extraction provider interface and authenticated POST/PATCH
request bodies are unchanged. Extraction responses add nullable `attemptId` and
`leaseExpiresAt` fields.
