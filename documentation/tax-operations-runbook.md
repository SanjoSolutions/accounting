# Production tax operations runbook

Production filing is fail-closed. `TAX_PRODUCTION_FILING_ENABLED=true` is necessary but is not sufficient: both service URLs must be HTTPS, both credentials must be supplied through the deployment secret store, `TAX_GATEWAY_QUALIFICATION_ID` must identify the retained qualification record, and `TAX_GATEWAY_QUALIFIED_FORM_VERSIONS` must contain the exact form version being sent. Never place credential values in logs, tickets, qualification records, or diagnostics.

## Test gateway boundaries

The default Playwright service, `e2e/local-tax-gateway-emulator.mjs`, is only a
local lifecycle emulator. Its synthetic validation result and receipt prove
application workflow, persistence and idempotency behavior only. They are not
ELSTER, ERiC, official form validation, or interoperability evidence.

An authorised external annual-tax gateway can be checked without mocks by
setting `ANNUAL_TAX_GATEWAY_CONTRACT_URL` to its HTTPS test endpoint and
`ANNUAL_TAX_GATEWAY_CONTRACT_CREDENTIAL` through the local secret environment,
then running:

```sh
pnpm exec playwright test e2e/annual-tax-gateway.contract.spec.ts
```

`ANNUAL_TAX_GATEWAY_CONTRACT_TAXPAYER_ID` may select the authorised test-tenant
identity. The contract sends synthetic 2025 KSt and GewSt datasets only to the
gateway's non-binding `validate` endpoint. It deliberately does not call
`submit`; a passing result demonstrates this application's HTTP adapter
contract, not ERiC interoperability or acceptance by a Finanzamt. Retain the
external gateway's redacted protocol and independent qualification evidence
before enabling any production form version.

## Qualified VAT, corporation-tax and trade-tax contract

The repository also contains a stricter, opt-in contract for the currently
supported `USTVA`, `UST_ANNUAL`, `KST` and `GEWST` paths for both `2025.1` and
`2026.1`. Run it only against a gateway and synthetic taxpayer
identity that the operator is authorized to use in the gateway's explicit
`TEST` or `STAGING` environment:

```sh
pnpm test:contract:qualified-tax
```

The contract is disabled unless every `QUALIFIED_TAX_GATEWAY_CONTRACT_*`
setting is supplied, the endpoint is HTTPS, the exact eight form versions are
listed, an independent qualification-record ID is named, an absolute protocol
directory is configured, and submission is separately acknowledged. For each
form it requires all three outcomes from the real remote adapter: successful
validation, rejection after removing a required field, and accepted staging
submission with a nonblank receipt. Every response must carry a
machine-readable protocol object whose gateway ID, qualification ID, form
version, outcome, protocol ID, timestamp, and `TEST`/`STAGING` marker match the
configured contract. The exact same request and idempotency key is submitted a
second time; only the same protocol identity and receipt digest count as an
idempotent replay. Redacted evidence records retain request, response and
receipt SHA-256 digests, not declaration payloads, taxpayer IDs, credentials,
PINs, or raw receipts. A non-JSON remote failure is also retained as its status,
media type, byte length, digest and a bounded redacted excerpt before the
contract fails closed.

The adapter request currently uses deterministic datasets produced by the
application's versioned tax-form registry. Provider wire schemas remain a
provider-owned boundary: this repository does not guess an ELSTER or gateway
schema. Qualification is valid only when the authorized adapter explicitly
accepts this documented JSON contract or is replaced by a reviewed transformer
for the provider-issued schema.

The manual `Qualified tax gateway contract` GitHub workflow is intentionally
absent from ordinary push and pull-request CI. It requires an environment
approval plus repository secrets. A skipped workflow or test proves nothing.
A passing run proves only the named gateway adapter and exact form versions
against the named test environment and retained qualification record. It does
not prove that this repository is listed by ELSTER as a software product, does
not certify the gateway's independent qualification claim, and does not prove
production acceptance by a Finanzamt.

## Native ERiC Bilanz_6.9 validation contract

The native bridge in `tools/eric-bridge` is narrower: it calls
`EricBearbeiteVorgang` with `Bilanz_6.9` and the E-Bilanz check plugin. It is
therefore E-Bilanz validation/submission plumbing only and is not evidence for
UStVA, annual VAT, KSt, or GewSt. Direct ERiC evidence for those tax types
requires the proprietary ERiC developer package, current official form/data
type specifications, a manufacturer ID, and authorized test credentials from
the ELSTER developer program. The [official ELSTER developer page](https://www.elster.de/eportal/infoseite/entwickler)
describes registration, developer-area access, the ERiC download, and the
manufacturer-ID application.

The repository's `ERiC Bilanz validation contract` workflow is a manual,
environment-approved validation-only gate for that narrow bridge. It requires a
self-hosted Windows runner on which the authorized proprietary runtime,
`ericapi.dll`, `checkBilanz_6_9.dll`, compiled bridge, manufacturer ID, test
marker, authorized test tax number, and official sample XBRL are already
installed. Configure the exact documented result as either `SUCCESS` with code
`0`, or `TEST_MARKER_RESPONSE` with its exact nonzero code and a status-text
fragment, then explicitly choose `AUTHORIZED_VALIDATION_ONLY`.

The test always calls `runEric(..., { send: false })`; its contract rejects
certificate and PIN inputs. It archives hashes of the envelope, sample, bridge,
runtime API, plugin, result XML and server-response XML, plus bounded redacted
previews. It never archives raw XBRL, tax numbers, manufacturer/test-marker
values, certificates, PINs, or a submission receipt. A passing run proves only
that the named local binaries produced the configured TEST validation outcome
for the sample through `Bilanz_6.9`. It is not a submission and must not be
described as Finanzamt acceptance. A local skip caused by missing proprietary
software or configuration is explicitly non-evidence.

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
