# Production tax operations runbook

Production filing is fail-closed. `TAX_PRODUCTION_FILING_ENABLED=true` is necessary but is not sufficient: both service URLs must be HTTPS, both credentials must be supplied through the deployment secret store, `TAX_GATEWAY_QUALIFICATION_ID` must identify the retained qualification record, and `TAX_GATEWAY_QUALIFIED_FORM_VERSIONS` must contain the exact form version being sent. Never place credential values in logs, tickets, qualification records, or diagnostics.

## Onboarding and release gate

1. Reconcile imported outgoing invoice numbers for each tenant/year with `reconcile-number-sequence`. Supply the immutable imported numbers and explicitly confirm the first unused number. The service refuses duplicates, other formats, backward movement, and collisions with issued, reserved, or voided local numbers.
2. Call `GET /api/tax/readiness?kind=USTVA&period=YYYY-MM` (and each applicable annual kind/year). Resolve every failed check: effective STANDARD/MONTHLY profile, VAT control mappings, installed form version, annual facts, posted ledger, accepted authenticated E-Bilanz evidence, and invoice sequence.
3. Qualify validation, submission, rejection, timeout, recovery, correction, and cancellation against the current official ELSTER/ERiC staging environment. Retain redacted protocols and receipts outside application logs. Add the exact qualified form versions and qualification record identifier to deployment configuration.
4. Obtain professional German tax approval. Enable production filing only after the approval and gateway qualification records have been reviewed by two operators.

## Monitoring and response

Alert on gateway request timeout rate, HTTP failure rate, declarations in `UNKNOWN` or `uncertain`, requests in `PROCESSING` for more than five minutes, and repeated recovery failures. Dashboards must group by action, outcome, gateway authority identifier, tenant pseudonym, and form version; they must never contain bearer credentials or declaration payloads.

- Timeout or connection loss after submission: treat the result as uncertain. Do not create a new request key. Use the persisted workflow's recovery action, which queries the gateway with the original idempotency key. Escalate if recovery remains uncertain.
- Gateway downtime: disable new production filing, preserve queued prepared datasets, and continue recovery of already uncertain submissions when the gateway is reachable. Do not bypass readiness flags.
- Credential rotation: install the new deployment secret, restart instances so cached adapters are replaced, exercise validation in staging, then revoke the old credential. The gateway configuration identity includes only a one-way credential fingerprint; the credential is never returned.
- Suspected credential exposure: disable production filing, revoke and rotate immediately, search logs for the secret through an authorized out-of-band process, and open a security incident. Do not paste the secret into diagnostics.
- Form/gateway upgrade: repeat the official contract suite and professional review. Update the qualification ID and exact version allow-list only after receipts and redacted diagnostics are retained.
