# Unternehmensregister disclosure qualification

Status on 15 October 2026: **local contract readiness only; no external qualification claimed**. Issue #32 requires real authorized provider outcomes. No enrollment, transmission, payment or publication was performed by this change.

The application can prepare immutable disclosure packages for approved annual
accounts. It must not claim that a package was filed with the
Unternehmensregister until an authorized provider Webservice returns a retained
acceptance receipt.

The Unternehmensregister permits order transmission through the
[Publikations-Plattform or a software Webservice](https://unternehmensregister.de/de/so-gehts/uebermitteln?dest=ureg&language=de).
The provider describes its annual-accounts interface as a mass interface for
XML or XBRL and supplies the workflow and interface specifications on request:
[official interface information](https://publikations-plattform.de/order/de/arbeitshilfenstandards/standards/schnittstellen).
Those provider-controlled specifications, identification and test access are
therefore external qualification inputs, not files that this repository may
guess or replace with a local emulator.

## Qualification gate

The manual `Qualified Unternehmensregister disclosure contract` workflow runs
only in the protected `disclosure-qualification` GitHub environment and only
after the operator confirms authorized TEST/STAGING use. Configure the exact
provider-issued endpoint, schema version, qualification record, electronically
identified submitter and protocol directory in that environment. Keep the
credential and submitter identity in secrets.

The gate executes both supported cases:

1. `MICRO-HINTERLEGUNG`
2. `SMALL-OFFENLEGUNG`

Each case must pass official validation, reject a reviewed invalid provider
payload, accept an idempotent non-binding submission, and return a protocol
bound to the source package, exact wire bytes, request, submitter, fiscal year,
configured environment, schema and qualification. Acceptance also binds the
receipt digest; replay must return the same receipt and protocol identity.
Non-JSON failures retain status, media type, byte length and digest, never raw
provider prose. A disabled or skipped contract is not qualification evidence.

The provider XML/XBRL layout is intentionally not invented here. The harness
requires reviewed, pinned annual/manual app exports and provider payloads for
both cases before making any request. Mapping the minimized disclosure to the
provider's exact schema still requires its specifications and review. The JSON
`/validate` and `/submit` routes are this repository's adapter contract, not an
assertion about the official provider API.

Run locally only with an authorized environment:

```powershell
pnpm test:contract:qualified-disclosure
```

Production filing remains disabled until the provider contract has passed and
the resulting qualification identifiers have been approved for deployment.

## Exact owner prerequisites

1. Request Webservice onboarding, workflow concepts, interface descriptions,
   current schemas and non-binding qualification access from
   **webservice@bundesanzeiger.de**, as specified by the official interface page
   above (checked 15 October 2026). Public documentation does not establish the
   exact test endpoint, authentication scheme or schema release. Obtain these
   from the operator; do not assume a test service exists because this harness
   supports one.
2. Register and complete identification for the actual authorized submitter.
   Retain the provider's submitter and qualification identities, approved
   synthetic company/register identities, and permission for the particular
   TEST or STAGING deliveries. The official transmission guide above requires
   registration/identification and an order defining the documents to disclose.
3. Implement and review the provider adapter against the supplied specification,
   including genuine response authentication and independent enforcement of
   non-binding routing. An echoed environment flag or simulator receipt is not
   provider evidence. Owner authorization is required before any external run.
4. Using only synthetic data in a disposable isolated app, approve MICRO and
   SMALL annual accounts and download both the annual and minimized manual ZIPs
   from each selected version. Follow
   [the existing export workflow](annual-documents-and-manual-disclosure.md).
   Never use `accounting.db`, live document storage or port 3000. If needed,
   check that issue port 3232 is unused before starting an isolated app.
5. Retain the exact ZIPs and recorded export hashes. Transform their reviewed
   minimized disclosures into valid provider wire bytes, plus a distinct
   intentionally invalid payload for each case. Review identity, periods,
   required disclosures, reliefs and establishment date against those exports.

## Reviewed input artifact

Use an authorized artifact workflow to retain `qualified-disclosure-inputs`.
This task does not upload an artifact. Its root contains `manifest.json` and
the eight referenced files. Independently review and pin the originating run ID
and exact manifest SHA-256 in the protected environment. Do not select a moving
latest run or treat a hash as proof of app provenance or correct schema mapping.

The manifest uses this shape; replace placeholders with actual reviewed values
and lowercase 64-character SHA-256 digests:

```json
{
  "format": "disclosure-qualification-inputs-1",
  "gatewayId": "provider-adapter-id",
  "qualificationId": "provider-issued-qualification-id",
  "schemaVersion": "exact-provider-schema",
  "environment": "STAGING",
  "adapterVersion": "reviewed-adapter-commit",
  "review": { "syntheticDataOnly": true, "nonBinding": true, "mappingApproved": true },
  "cases": [
    {
      "disclosureCase": "MICRO-HINTERLEGUNG",
      "annualBundle": { "file": "micro-annual.zip", "sha256": "<digest>" },
      "manualBundle": { "file": "micro-manual.zip", "sha256": "<digest>" },
      "validPayload": { "file": "micro-valid.xml", "sha256": "<digest>" },
      "invalidPayload": { "file": "micro-invalid.xml", "sha256": "<digest>" }
    },
    {
      "disclosureCase": "SMALL-OFFENLEGUNG",
      "annualBundle": { "file": "small-annual.zip", "sha256": "<digest>" },
      "manualBundle": { "file": "small-manual.zip", "sha256": "<digest>" },
      "validPayload": { "file": "small-valid.xml", "sha256": "<digest>" },
      "invalidPayload": { "file": "small-invalid.xml", "sha256": "<digest>" }
    }
  ]
}
```

The loader checks both cases, all pins, exact ZIP members, member hashes/lengths,
annual identity/reconciliation, matching source version/checksum/close/approval,
supported size, and the explicit disclosure selection by regenerating its manual
files with the existing renderer. Traversal and files resolving outside the
artifact directory are rejected. Only the exact provider payload is transmitted;
the private companion and source ZIPs stay local. Protected review attests app
provenance and the provider mapping, which hashes alone cannot authenticate.
Keep original authenticated export records and the mapping review in the
qualification archive. The unit fixtures deliberately provide no such evidence.

## Protected environment settings

Configure required reviewers and branch restrictions on `disclosure-qualification`;
the YAML environment name alone does not configure those protections. Dispatch
only reviewed code after explicit owner authorization.

Every setting below has prefix `QUALIFIED_DISCLOSURE_CONTRACT_`:

| Setting | Location | Purpose |
| --- | --- | --- |
| `URL` | Secret | HTTPS adapter endpoint without userinfo, query or fragment |
| `CREDENTIAL` | Secret | Runtime authentication; never paste into logs/issues |
| `SUBMITTER_ID` | Secret | Actual identified authorized test submitter |
| `GATEWAY_ID` | Protected variable | Exact adapter identity |
| `QUALIFICATION_ID` | Protected variable | Provider qualification record |
| `SCHEMA_VERSION` | Protected variable | Exact provider schema release |
| `ENVIRONMENT` | Protected variable | Exactly `TEST` or `STAGING` |
| `FIXTURE_RUN_ID` | Protected variable | Reviewed run supplying the artifact |
| `FIXTURE_MANIFEST_SHA256` | Protected variable | Independently reviewed manifest hash |

The workflow supplies `ENABLED=true`, `ALLOW_SUBMISSION=true`, both `CASES`, and
absolute `FIXTURE_DIR`/`PROTOCOL_DIR` under runner temporary storage. Authorized
local execution also needs these settings supplied securely. Credentials belong
only in runtime or secure CI secrets. If AWS Secrets Manager is used, resolve
dynamic references through `asm-exec`, never retrieve values into agent context.

## Adapter protocol

`POST /validate` accepts `{ dataset }`; `/submit` adds `idempotencyKey`. The
dataset names destination, exact environment, `nonBinding: true`, case, year,
schema, submitter, qualification, source package checksum, manual bundle digest,
adapter version, wire payload SHA-256, and `{ encoding: "base64", content }` for
the exact payload bytes. The key hashes the entire canonical dataset, so changes
to bytes, identity, schema, source or environment produce a different key.
Redirects are disabled and the suite does not automatically retry requests.

HTTP 200 validation returns `valid: true, errors: []`; rejection returns
`valid: false` and a nonblank string in `errors`; acceptance returns
`outcome: "accepted", errors: []` plus a nonblank `receipt`. All return a protocol:

- Exact `gatewayId`, `qualificationId`, `schemaVersion`, `disclosureCase`,
  `fiscalYear`, `submitterId` and configured `environment`.
- `destination: "UNTERNEHMENSREGISTER"`, `nonBinding: true`, expected `stage`
  (`VALIDATED`, `REJECTED`, `ACCEPTED`), nonblank `protocolId`, valid `timestamp`.
- `sourcePackageChecksum`, actual valid/invalid wire `packageSha256`, and
  `requestSha256` over UTF-8 `JSON.stringify(request)`, including the submission
  key when present.
- Acceptance `receiptSha256` over the exact UTF-8 receipt. Replay must match both
  that digest and the original protocol identity.

These normalized fields must map to genuine provider evidence. The adapter must
never label pending, failed or simulated deliveries as accepted.

## Evidence and release gate

Version-2 redacted evidence binds manifest/ZIP/source/wire/request digests,
schema, adapter, qualification, exact environment and hashed submitter. Raw
submitter, receipt, payload, private sources and arbitrary provider prose are
excluded. Failed response checks retain `contractPassed: false`; a transport
failure establishes no provider outcome. Both cases and every stage must pass
in a successful workflow run. Partial success files from a failed run do not
establish qualification.

Evidence files use exclusive creation. The workflow archives evidence even on
failure, distinguishes run attempts, and fails upload if no files exist. Retain
redacted protocols with protected original receipts, submitter-to-hash mapping,
fixture files and mapping review in the controlled evidence archive. GitHub's
90-day artifact retention is not the permanent archive.

The harness has no path to mark app packages filed or enable production. Only
TEST/STAGING configurations and non-binding protocols pass. After genuine
qualification succeeds, deployment/publication still needs separate explicit
authorization. Until provider access, mapping review, owner authorization and
the genuine outcomes exist, issue #32 remains externally blocked.
