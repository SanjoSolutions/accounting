# Issue 20: draft independent reporting integrity review

Reviewed by Codex on 2026-10-13 in an isolated worktree. The disabled autoreview workflow was not used. Verification was interrupted on request; this draft is not a final clean review verdict.

## Scope and trust boundaries

Baseline: `1eddf69c3bfdb4bd40f3653e4266178626d3ca64` (remote main when this review started). The draft source commit and verification status are recorded in the linked PR. This review covers the reporting domain present at that baseline plus this PR's fixes. It does not certify subsequent changes in #35, #36, #37 or #38.

The review traced audit/migration package creation and verification, canonical tenant identities, cash and asset aggregates, annual-account approval state, ERiC receipts and amendment state, canonical XBRL serialization, retained reporting objects, annual source selection, and the HGB readiness-to-lock boundary. Existing adversarial suites were inspected alongside the implementations; new regressions exercise the findings below.

Trusted inputs remain the authenticated tenant/actor supplied by server authorization, the database's immutable registrations and audit anchors, and externally supplied signing and revision-store adapters. Checksums establish consistency with these anchors; they do not protect against an attacker replacing the database, object storage and trusted signing material together.

The core annual/ERiC authority interfaces require a durable compare-and-swap store. Its complete signed bytes and revision must commit atomically, its authority-stream head must survive key rotation, and callers must complete that commit before publishing authoritative results or external effects. The new disposable SQLite adapter is a **test fixture**, not a deployed production adapter. Prisma reporting persistence and tax workflow persistence are separate application paths. No official ERiC, KoSIT, ELSTER or filing-provider acceptance is claimed.

## Accepted findings and fixes

| Finding | Impact and correction | Regression coverage |
| --- | --- | --- |
| XML validity depended on the serializer's assertion | A canonical-looking body could contain forbidden XML characters or an unpaired surrogate. Independently parse namespace-aware XML and reject lossy UTF-8 conversion before retaining transmitted bytes. | `eBilanzIntegrityReview.spec.ts`: illegal controls, noncharacters, surrogate and valid escaped Unicode |
| Signed ERiC hydration accepted impossible amendment history | Orphaned/skipped amendment chains, inconsistent active/superseded states, backwards receipt chronology and noncanonical receipt bytes could survive trusted-signature verification. Validate the complete lifecycle graph independently of array order. | `eBilanzIntegrityReview.spec.ts`: signed adversarial histories and a valid reordered chain |
| Cash/asset aggregate identities admitted padded tenant/master spellings | Direct domain operations could accept identifiers that audit/annual boundaries reject. Require canonical trimmed tenant and cash-book/account identities at the aggregate boundary. | `tenantIntegrityReview.spec.ts`: append, close, export, empty asset schedule and foreign-tenant cases |
| HGB evidence authority checked metadata without checking retained bytes | Deleted or substituted evidence could still authorize a close. Resolve tenant-owned live registrations, reject conflicting hashes, read actual bytes and include verified content in the close fingerprint. | `closeEvidence.spec.ts`, `hgbCloseRepository.spec.ts` |
| Reporting package consumers did not bind all retained representations | Approval and close could trust a database package while its object was missing or different. Bind package checksum, selected registration, storage key, exact payload bytes and object hash; verify export manifest ownership/purpose/reference. | `retainedReportingPackage.spec.ts`, `reportingRepository.persistence.spec.ts`, `hgbCloseRepository.spec.ts` |
| A new close evaluation could use an annual package from old sources | An approved package was selected without proving that its underlying ledger, comparative period, mappings, profile, workpapers, adjustments and evidence remained current. Persist a source fingerprint and recheck it inside registration/approval and final lock; supersede older approvals atomically and reject backwards approval. | `annualReportingSource.spec.ts`, `reportingIntegrityReview.spec.ts`; corrected-profile close E2E |
| New audit exports could bless changed evidence bytes with a new hash | Source loading rehashed storage contents without comparing the original retention anchor, and database datasets were read outside one snapshot. Read source rows in one transaction and verify evidence bytes against their live tenant-owned original registration. | `reportingRepository.persistence.spec.ts` |

The first focused XML/hydration run reproduced 12 failing cases before the fixes; the canonical-identifier run reproduced four. The new unit regressions passed in the completed run before dependency updates. Existing migration-manifest, signed annual hydration, hostile XML root/attributes/body, namespace, duplicate-fact, replay and receipt tests remain part of the full suite.

The repository dependency audit also found 33 advisories (3 critical, 16 high, 11 moderate, 3 low) in the baseline dependency tree. This includes the [Next.js Windows-hosted remote-code-execution advisory](https://github.com/advisories/GHSA-p293-qw3h-jr36). The dependency remediation updates Next.js to 16.3.8, PDF.js to 6.2.108, Vitest to 4.1.11, CSV parsing and vulnerable transitive packages. The final `pnpm run audit:security` reports **no known vulnerabilities**. The missing V8 coverage provider is now explicitly installed at the matching Vitest version.

## Durable state verification

`durableAuthorityReview.spec.ts` exercises both authority types with a real disposable SQLite compare-and-swap store: fresh-process readback of the exact signed snapshot, two workers hydrated from one head, stale writer rejection, old-snapshot replay rejection, signing-key rotation without resetting the stream, wrong-key rejection, storage failure without local revision advancement, retry, and rejection of a new empty authority against an existing stream. Existing domain tests cover semantic tampering and approval/submission transitions.

## Compatibility and integration

Annual packages created before the source-binding field was introduced remain retained historical artifacts. They cannot authorize a new approval, disclosure preparation or close: regenerate and approve a package against the current sources. The fiscal lock's own status/timestamp is excluded from the source fingerprint, so locking does not invalidate its package. Concurrent preparation that loses the version/source race fails closed and removes its unregistered object; the caller can retry.

Evidence without an intact original retention registration also fails closed. Rehashing substituted or unverified legacy bytes is not a migration strategy; the original evidence and its provenance must be established through the supported retention workflow.

No schema migration, live-data rewrite, UI layout change or production submission is part of this PR. The annual generator and evidence/package checks were extracted into shared modules; the shared error type moved out of the runtime module to avoid an import cycle.

The existing close page models needed maintenance for the current booking-batch workflow and translated labels/date presentation. They continue using real UI actions and synthetic local-emulator receipts. The corrected-profile scenario prepares and independently approves a new annual package before evaluating a new close.

## Verification

- Before dependency updates, the full Vitest suite passed: `node node_modules/vitest/vitest.mjs run --reporter=verbose --maxWorkers=4 --testTimeout=60000 --hookTimeout=60000`: **239 files passed, 2 skipped; 1,716 tests passed, 5 skipped**. The skipped cases require opt-in official validation tooling. Larger per-test budgets were used after host-load timeouts in migration setup; no assertion was disabled.
- With patched dependencies, the first coverage run passed 1,715 tests and failed one obsolete assertion requiring the old dependency versions. That assertion was updated and passed in the next run. The full rerun was interrupted on request; a complete passing run and coverage thresholds remain pending.
- `pnpm run typecheck`: passed.
- `pnpm run build`: passed.
- The dependency audit reports no known vulnerabilities; the minimized manifest also passed an offline frozen-lockfile check.
- Browser verification uses `http://127.0.0.1:3115`, `review-20-playwright.db`, `.playwright/review-20-documents`, and a local synthetic tax gateway on port 3315. Earlier attempts exposed stale page-model locators and dev-route failures. Page models were repaired and Next.js was patched, but the final browser rerun remains pending.

No test, browser action or reset used port 3000, the company database or live document storage. The issue's production gate must be assessed against the exact integrated commit; this document cannot approve a later combined tree by implication.
