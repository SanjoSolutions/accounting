# Retained app-output ERiC validation contract (#31)

Implemented locally by Codex, 15 October 2026. **No official validation,
TEST/STAGING transmission, receipt or production qualification is claimed.**
The existing sample smoke test is insufficient for #31. The new contract prepares
the app-output validation part of that issue; transmission remains an external gate.

## Available commands

- `pnpm test:contract:eric` requires explicit enablement and runs the retained
  app-output positive/negative contract. Disabled configuration exits unsuccessfully.
- `pnpm test:contract:eric:sample` is the existing official-sample installation
  smoke test. It may be skipped when disabled and does not qualify app output.
- Ordinary `pnpm test` exercises synthetic mocked contract behavior and skips both
  proprietary contracts unless they are explicitly enabled. Mock results are not
  official evidence.

The manual workflow `eric-retained-validation-contract.yml` uses the protected
`eric-test-qualification` environment and an ERiC-labelled Windows runner. Its
authorization input defaults to `DO_NOT_RUN`. Configure required environment
reviewers and restricted artifact access before using it. No workflow was dispatched.

## Prepare the input after obtaining authorized runtime access

1. Use an isolated app/database/document store and a synthetic fixture. Seed the
   authorized test identity before generating the package. Use a permitted test
   clock for a completed fiscal period. Never substitute identities in retained XML.
2. Retain the app's XBRL-with-taxonomy ZIP and the export record identifying its
   checksum, close generation and version. The supported ZIP contains
   `e-bilanz-YYYY.xbrl`, `export-data.json`, `local-validation.json` and the pinned
   taxonomy tree. An optional app `manifest.json` is checked if present. For an
   external-handoff ZIP, use its unchanged `xbrl-mit-taxonomie.zip` member and its
   recorded member checksum, retaining the enclosing export as provenance.
3. Prepare the private qualification manifest below. Obtain diagnostic expectations
   from the exact installed SDK documentation or a reviewed official contract.
   Do not guess codes from this repository's synthetic unit tests. The positive
   diagnostic must mean successful content validation, and the negative diagnostic
   must identify the invalid-decimal rejection. A test-marker-only response does
   not establish successful content validation.
4. Set the runtime configuration in the protected environment. Keep runtime files,
   manifest, identities and input artifacts outside Git. Pin the exact bridge,
   `ericapi.dll` and `plugins/checkBilanz_6_9.dll` bytes and record the SDK release.
5. Check out a clean commit matching `repositoryCommit`, review the manifest and
   source provenance, and authorize **validation only** before running the command.

The manifest is a reviewed operator input, not an authentication mechanism. Its
archive digest must come from the retained export record, not merely a fresh hash
of an untrusted ZIP. Internal consistency checks cannot independently prove who
generated a caller-supplied artifact. The current serializer must reproduce the
retained XML exactly, otherwise regenerate and retain a new version in the app.

Required manifest shape (replace every placeholder; illustrative values are not
official diagnostic assertions):

```json
{
  "schemaVersion": "ERIC_RETAINED_VALIDATION_V1",
  "dataClassification": "SYNTHETIC",
  "retainedExportId": "<retained export record ID>",
  "archiveSha256": "<64 lowercase hex characters from the retained record>",
  "repositoryCommit": "<40 lowercase hex characters of the clean generator/runner commit>",
  "fixtureId": "<reviewed synthetic fixture>",
  "fixtureVersion": "<fixture version>",
  "reportVersion": "<retained report version>",
  "sdkVersion": "<exact authorized SDK release>",
  "runtime": {
    "bridgeSha256": "<64 lowercase hex characters>",
    "apiSha256": "<64 lowercase hex characters>",
    "pluginSha256": "<64 lowercase hex characters>"
  },
  "diagnosticContractReference": "<SDK document/version/section reviewed for both expectations>",
  "positiveDiagnostic": { "namespace": "<official namespace>", "localName": "<diagnostic element>", "value": "<successful content-validation value>" },
  "negativeDiagnostic": { "namespace": "<official namespace>", "localName": "<diagnostic element>", "value": "<invalid-decimal diagnostic value>" },
  "negativeStatusCode": "<replace with the documented nonzero integer status>"
}
```

The current matcher supports an exact namespace-qualified leaf element in the
result XML. If the official release uses another response shape, extend the
parser and its regression tests after reading that release's documentation.
Do not relax it to substring matching to obtain a green run.

Required configuration:

| Variable | Value |
| --- | --- |
| `ERIC_RETAINED_CONTRACT_ENABLED` | `true` only for an authorized run |
| `ERIC_QUALIFICATION_AUTHORIZED_TEST_MODE` | `true`, validation-only authorization |
| `ERIC_QUALIFICATION_BRIDGE_PATH` | Absolute bridge executable path |
| `ERIC_QUALIFICATION_RUNTIME_DIR` | Absolute installed runtime directory |
| `ERIC_QUALIFICATION_MANUFACTURER_ID` | Authorized manufacturer identity via secure runtime configuration |
| `ERIC_QUALIFICATION_TEST_MARKER` | Permitted numeric test marker from official documentation |
| `ERIC_QUALIFICATION_TEST_TAX_NUMBER` | Authorized 13-digit identity already present in the retained dataset |
| `ERIC_RETAINED_PACKAGE_PATH` | Absolute retained XBRL-with-taxonomy ZIP path |
| `ERIC_RETAINED_MANIFEST_PATH` | Absolute private qualification manifest path |
| `ERIC_QUALIFICATION_EVIDENCE_DIR` | Absolute access-controlled evidence directory |

Qualification certificate/PIN inputs are rejected. The native call always uses
`send:false` and an explicit configuration without a certificate. No live app,
database, production credentials or submission endpoint is required.

## Evidence and failure behavior

Verification checks the archive hash, all packaged taxonomy members, dataset,
manifest when present, and exact current serializer output. Local structural
diagnostics are checked for consistency but never count as official validation.
Only the two schema-reference URLs change for ERiC; the transform is versioned
and the instance body is preserved inside the transport envelope. The negative
case changes the single numeric `bs.ass` fact to `INVALID_DECIMAL`. Its bytes and
mutation version are separately hashed. The negative XML stays well-formed.

Both calls use the same pinned runtime. A positive case needs status zero and
the exact reviewed success diagnostic. A negative case needs the exact configured
nonzero content-rejection status and diagnostic. Both require `sent:false`, no
server response, and unchanged runtime hashes before/after the call. Exceptions,
missing DLLs, malformed protocols, diagnostic mismatches and unexpected receipts
fail the contract. Both case results are retained before the final assertion.
Preflight integrity/configuration failures occur before any native invocation.

Each attempt writes immutable redacted JSON summaries at the evidence root.
They include the qualification identity, artifact/runtime digests, fiscal dates,
status codes, diagnostic match result, structural XML preview and hashes of
untrusted text. `private/<attempt>/` retains the exact original ZIP, input manifest,
XBRL forms, envelopes and raw result XML for authorized troubleshooting. This
directory may contain test identities and restricted diagnostic data; keep it in
access-controlled storage and archive it through the owner's restricted evidence
process. Only root JSON summaries are uploaded by the workflow. Review even those
summaries before sharing them publicly.

Repeated validation keeps the same qualification identity and request ticket but
creates a new evidence attempt. A failed or uncertain native call is never retried
automatically. This is safe repetition of non-submitting validation; it does not
prove submission idempotency. No result updates the production qualification
registry. Runtime, generator, artifact or manifest changes require new evidence.

## Remaining external gate and next owner action

On 15 October 2026, this worktree had no `.eric` directory and the executing process
had no ERiC environment configuration. This is a local availability check, not a
claim about every installation or protected CI environment.

A follow-up metadata check found no runtime directories at the primary checkout's
`.eric`, the user's `.eric`, `C:/Program Files/ERiC`,
`C:/Program Files (x86)/ERiC` or `C:/eric`. GitHub returned no repository
environments. The repository runner-inventory endpoint returned HTTP 403, so
availability of authorized shared runners remains unknown. No certificate,
credential values or business records were read. Developer-account approval
itself remains unconfirmed; first check whether ELSTER has already granted access,
and register only if access has not been granted.

The official process remains developer registration, authority review, developer
access, runtime download and a separate manufacturer-ID application. The owner
can use the [official registration form](https://www.elster.de/elsterweb/registrierung-entwickler/form)
and the [ELSTER developer instructions](https://www.elster.de/eportal/infoseite/entwickler)
(checked 15 October 2026). The form requires company/contact data and CAPTCHA;
registration does not guarantee access. The existing
[direct-ERiC plan](./eric-direct-qualification-plan.md) includes a registration draft.

After access is granted, provide the authorized runtime, matching plugin, private
SDK documentation and permitted test identities through secure runtime/CI
configuration, then authorize the retained validation run. Review the bridge ABI
and flags against that SDK before executing proprietary code.

#31 remains open until the official positive/negative contract actually passes,
redacted protocols are archived, and a separately authorized TEST/STAGING
submission yields a receipt bound to the same retained package and qualification
identity. Submission retry/uncertain-outcome behavior must then be qualified
against the real receiver contract. Neither test credentials nor sending
authorization, receipt formats, correction semantics or current SDK error codes
are inferred here. Production remains blocked by the existing integration gates.
