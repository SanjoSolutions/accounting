# Retained E-Bilanz report review (issue #19)

XML preparation and ZIP export now publish reports through
`retainEBalanceReport`. Both preserve the exact dataset, XML, checksums and
`LOCAL_STRUCTURAL` diagnostics from the authoritative exporter introduced in
#40. Publication rechecks source evidence inside the transaction. Identical
close-generation/checksum retries reuse the existing report; corrections append
a version with `supersedesId` and a supersession audit event. An earlier approval
remains evidence of that earlier version and is not copied to its successor.

Each new report registers its stored artifact's actual checksum (XML or ZIP),
local validation engine and time, and preparation/validation audit events.
Retention uses the existing ten-year `TAX_RECORD` policy through calendar-year
end, starting no earlier than report creation or fiscal-period end. This avoids
shortening retention for non-calendar periods and later preparation. The
calendar-year origin follows [AO §147(4)](https://www.gesetze-im-internet.de/ao_1977/__147.html),
checked on 15 October 2026. Classification, later events and legal holds still
require the existing retention controls and professional review.

## Authenticated operations

- `POST /api/compliance/e-bilanz` with `action: "report.approve"`, `reportId`,
  `reportChecksum`, `confirmed: true` and a nonblank `reason` records local
  review. It requires write permission and the latest report for that tenant
  and fiscal period. Current close, profile, reconciliation and evidence checks
  run in the same transaction as approval and audit. Retries preserve the first
  approval actor/time; stale or superseded reports cannot be approved.
- `GET /api/compliance/e-bilanz/<id>` returns the exact stored XML or ZIP,
  including historical versions. It verifies retention and both artifact/XML
  checksums, records the authenticated actor's access and sends private,
  non-cacheable download headers. Read-only members can download; foreign
  tenant IDs do not grant access. Existing ZIP reports retain compatibility
  through their original `TaxExport` retention record.

The direct E-Bilanz workspace's report history exposes these operations.
Approval is **local report review only**. It does not mark an official gateway
validation, send tax data, create a receipt, or bypass ERiC configuration.
The existing external handoff from #42 remains unchanged.

The additive migration freezes report identity and any recorded local
validation/approval evidence. It does not invent diagnostics, approvals or
receipts for historical rows, rewrite previous audit events, or mark predecessors
as officially amended.

## Verification and remaining qualification

Migrated temporary SQLite/storage tests cover concurrent publication and
approval retries, exact checksum confirmation, tenant boundaries, stale and
superseded reports, historical XML/ZIP access, tamper rejection, audit rollback,
audit-chain verification and database immutability. Route tests cover delegated
actors and read-only permissions. Playwright uses page models, port 3219,
`issue19-playwright.db` and `.playwright/issue19-documents`; its retained fixture
is explicitly historical. Separate intercepted view data is used only to
capture the review form for visual inspection, never to approve or transmit.

Issue #19 remains open. The supported taxonomy/dataset and report-form scope
remain those documented in `ebilanz-export-contract.md`; domain expansion is
owned by #15. The direct ERiC/official transport, receipt qualification and
uncertain-outcome recovery qualification are owned by #31. Completion still
requires actual current-environment validation/receipts and professional German
tax review. Local structural validation and these tests are not evidence of
official acceptance or production compliance.
