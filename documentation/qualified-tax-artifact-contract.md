# Qualified tax gateway artifact contract

Prepared by Codex for issue #30. This is a local engineering contract, not a
qualification certificate. It does not enable production filing.

## Input and provenance

`QUALIFIED_TAX_GATEWAY_CONTRACT_ARTIFACT_BUNDLE` is an absolute path to a UTF-8
JSON file of at most 5 MiB. Its exact byte SHA-256 must match
`QUALIFIED_TAX_GATEWAY_CONTRACT_ARTIFACT_SHA256`, supplied separately after
review of the application preparations and their source evidence. The bundle
contains:

```json
{
  "schema": "qualified-tax-gateway-artifacts",
  "version": 1,
  "environment": "STAGING",
  "artifacts": [
    {
      "preparationId": "<retained TaxDatasetPreparationRecord.id>",
      "datasetSha256": "<declarationDatasetHash(dataset)>",
      "dataset": {
        "kind": "USTVA",
        "period": "2025-01",
        "taxpayerId": "<authorized synthetic identity>",
        "formVersion": "USTVA-2025.1",
        "fields": { "ZAHLLAST": 1900 },
        "drilldown": { "KZ83": ["<retained synthetic source identity>"] }
      }
    }
  ]
}
```

This abbreviated shape is not a usable qualification fixture. Include exactly
one entry for each of USTVA, UST_ANNUAL, KST and GEWST for both 2025.1 and
2026.1, using unique preparation IDs. Preserve each dataset exactly as produced
by the app, including its taxpayer, fields, period, form version and drilldown.
`datasetSha256` uses the application's canonical `declarationDatasetHash`, not
the file's JSON formatting. The bundle pin covers the exact whole file.

The input must come from an isolated app with a disposable database and
separate document storage, using only authorized synthetic taxpayer/source
data. Review each dataset against its tenant-scoped preparation record and
the underlying reconciled VAT or annual-close evidence before pinning the
bundle. Keep those originals in the restricted source archive. Do not substitute
the unit-test fixtures, the registry's hand-entered sample datasets, or emulator
output.

**The pin proves integrity relative to that review, not provenance by itself.**
The loader does not contact a database or certify the preparation IDs. Current
VAT preparation records do not retain their full dataset payload; capture the
actual preparation result and verify its canonical hash against the record.
This patch does not add an automatic application-to-bundle exporter. An
authorized operator must supply and review the actual eight app outputs before
this contract can run. Never pin an arbitrary bundle just to make the gate pass.

## Adapter contract

The provider must explicitly support or have a reviewed adapter for these JSON
requests. They are this repository's gateway interface, not an official ELSTER
wire schema.

- `POST /validate`: `{ environment, dataset }`.
- `POST /submit`: `{ environment, dataset, idempotencyKey }`.
- Every HTTP 200 response has a `protocol` object containing `gatewayId`,
  `qualificationId`, `formVersion`, `stage`, `protocolId`, `timestamp`,
  `environment` and `requestSha256`. The last field acknowledges the SHA-256 of
  the **exact received UTF-8 request body**, not a reconstructed object.
- Validation returns `{ valid: true, errors: [], protocol }`; deleting an
  actual required field returns `valid: false`, a nonempty string error list
  and `stage: REJECTED`.
- Submission returns `{ outcome: "accepted", errors: [], receipt, protocol }`
  with a nonblank receipt and `stage: ACCEPTED`. Replay returns the same receipt
  and protocol ID for the identical request.

Only the configured TEST or STAGING environment is accepted. A bad validation,
negative-case result or retention failure stops the sequence before submission.
HTTP redirects are rejected. If a submission response is lost, its result is
unknown; rerun only with the same artifact, preparation identity, qualification
and environment so the idempotency key is preserved. Do not change these inputs
to force a new submission.

The default contract is disabled. A disabled run's eight skipped tests and the
offline runner unit tests prove no external acceptance. Every one of the eight
remote cases must pass all four exchanges (validation, rejection, acceptance,
replay), producing 32 successful redacted evidence records. Partial evidence
and `checksPassed: false` records do not qualify any release. Production's
separate exact-version allowlist and readiness checks remain unchanged.

## Owner handoff and current blocker

Read-only checks on 15 October 2026 found issue #30 open with no comments,
no locally configured `QUALIFIED_TAX_GATEWAY_CONTRACT_*` variables, and no
repository secrets returned by GitHub. The environment secrets/variables
endpoints returned 404 for `tax-gateway-qualification`; this can mean the
environment is absent or inaccessible. No provider request was made.

The next action is for an authorized owner to provide approved TEST/STAGING
access and explicit submission permission, and then:

1. Configure the protected environment with required reviewers. Supply the
   existing URL, credential and authorized synthetic taxpayer as secrets, and
   gateway ID, qualification ID and exact `TEST`/`STAGING` environment as variables.
2. Retain and review the eight real app preparations and their source evidence.
   Publish their restricted `artifacts.json` as `qualified-tax-input-artifacts`
   in a trusted run in this repository. Record its independently reviewed
   SHA-256 in `QUALIFIED_TAX_GATEWAY_CONTRACT_ARTIFACT_SHA256`.
3. Confirm the provider adapter supports the interface above and enforces
   non-production execution. A claimed environment marker is not independent
   proof of provider isolation or authority.
4. After the local change is reviewed and published under separate push
   authorization, dispatch the protected workflow with that artifact run ID
   and `AUTHORIZED_TEST_OR_STAGING`. Archive the full passing run and the 32
   redacted records alongside the restricted source archive and provider's
   independent qualification evidence.

This task has not enrolled with a provider, configured remote secrets,
dispatched the workflow, submitted a return, or changed production settings.
