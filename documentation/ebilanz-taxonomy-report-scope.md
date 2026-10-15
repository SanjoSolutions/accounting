# E-Bilanz taxonomy upgrades and report completeness (#15)

Prepared by Codex on 15 October 2026. This extends the authoritative #36/#40
dataset. It does not qualify an ERiC runtime or record a filing receipt.

## Official releases and upgrade contract

`OFFICIAL_E_BALANCE_TAXONOMIES` pins both original official archives:

| Release | Supported fiscal-period starts | SHA-256 | Receiver state |
| --- | --- | --- | --- |
| 6.9 | 2025-01-01 through 2026-12-31 | `accd62202d73c036910fee118b30730f0392934afc9730617788e30a0480df87` | Existing reviewed baseline |
| 6.10 | 2026-01-01 through 2027-12-31 | `de00ceaad0e532d238dea24a48160ec335422a3a71c38dd03c7b2b34b32fff76` | Local preparation only |

The through-dates bound this application's reviewed scope; they do not claim
that an older release becomes unavailable for corrections after that date.
Applicability uses the exact fiscal-period **start**, including non-calendar
years. Publication is checked separately from the receiver gate. Announced
TEST/live dates never automatically qualify a release. The existing
`receiverVerifiedOn` metadata is not an app/runtime qualification certificate.

For local 6.10 preparation, call
`prepareAuthoritativeEBalanceExport(ownerId, fiscalYearId, { taxonomyVersion: '6.10', taxonomyPreparation: 'LOCAL' })`.
The default remains the reviewed receiver baseline. Both modes return only
`LOCAL_STRUCTURAL` / `NOT_VALIDATED` evidence. Direct submission must still pass
the separate production and ERiC qualification gates.

`planEBalanceTaxonomyUpgrade(dataset, sourceModel, targetModel)` identifies
removed/prohibited account concepts, changed types/signs/contexts, newly required
concepts and calculation changes. It does not guess replacement mappings.
Regenerate from the approved authoritative source, run all reconciliation and
schema checks, and retain a new version. Never rewrite historical datasets,
XML, receipts or their checksums. A clean mapping plan is not successful ERiC
validation, and calculation changes still require review.

The 6.10 serializer removes the retired `transmissionNotYetPossible` GCD field,
adds the required `accountbalances.notPossible` child as nil for actual supplied
accounts, and emits the shareholder `idNotAssigned` choice. If no shareholder
identifier exists, the approved evidence must explicitly assert
`identifiersNotAssigned: true` with
`nilReasons['shareholder.<id>.identifiersNotAssigned']`. It cannot contradict an
existing identifier. No identifier is fabricated.

## V2 evidence

V1 evidence and retained XML remain supported with their original serialization.
New completeness declarations use `schemaVersion: EBILANZ_TAX_BALANCE_V2` in the
existing `TAX_BALANCE` reconciliation payload and approval API; no new tables or
parallel persistence lifecycle are introduced. V2 adds:

- `adjustments[].classification`: `{ kind: 'PERMANENT' }` or
  `{ kind: 'TEMPORARY', reversalExpectedThrough: 'YYYY-MM-DD' }`. A temporary
  closing difference must reverse after the fiscal period. Balanced journal
  lines still use the locked account IDs. Signed profit effects reconcile to
  the commercial-to-tax result difference. These remain tax-balance journals,
  not KSt/GewSt off-balance add-backs or a deferred-tax calculation.
- `revision`: `{ status, reason, supersedes }`, with the official statuses
  `E` (initial), `B` (corrected), `G` (amended), `BG` (both), or `I` (same
  financial statements with more detail). Initial reports require null;
  other statuses require `{ reportId, reportChecksum }`. The repository verifies
  the predecessor's tenant, period and retained XML hash at approval,
  preparation and publication recheck. This reference alone makes no statement
  about authority acceptance.
- `attachments`: one declaration for each `NOTES`, `MANAGEMENT_REPORT`,
  `AUDIT_REPORT` and `TAX_ELECTION_REGISTER`. Use
  `{ kind, status: 'PRESENT', text, evidenceIds }` for complete approved text,
  or `{ kind, status: 'NOT_APPLICABLE', reason }`. Missing/duplicate declarations
  and missing evidence are rejected. Attachment evidence joins the existing
  tenant-scoped approval fingerprint and is rechecked before publication.

V2 emits the individual tax asset register from the reconciled asset records as
an `nt.reg` fact with a linked plain-text XBRL footnote and declares `AV`.
The gross movement schedule remains `BAL`. Register entries include identity,
description, acquisition date, location, account/concept, tax acquisition cost,
depreciation and book/tax carrying values. The source movement records remain
in the immutable JSON companion. Approved attachments use the official
`nt`, `mgmtRep`, `nt.reportHGB321`, and `nt.RegisterEStG5Abs1S2` concepts with
fact-linked footnotes. Evidence IDs remain in JSON. Taxonomy 6.9 has no
`nt.RegisterEStG5Abs1S2`; declaring it present blocks that export rather than
silently dropping it or mislabelling it as another report.

The current official serializer supports ordinary domestic UG, GmbH and AG,
individual final annual tax balances before appropriation, GKV, trade income.
`E_BALANCE_CORPORATE_ANNUAL_FORM` registers this supported form subset and its
legal/revision codes for reviewed taxonomy versions 6.9 and 6.10; unreviewed
future releases cannot silently reuse that form. Its codes are checked against
both official archives in the automated suite.
The effective company profile determines and validates that scope; exact period
dates come from the fiscal period. V2 retains the derived report scope. An
unsupported profile is rejected before financial facts are generated.

## Ownership and remaining acceptance gates

Issue #19 owns durable report publication, immutable supersession/receipts and
production integration. Consume the existing prepared dataset and its revision
reference, recheck it in the publication transaction, and apply the lifecycle's
own latest-version and receipt rules. This change does not create a second
submission state machine, schema migration, or receipt store.

Issue #31 owns real ERiC runtime validation, preserved official diagnostics,
TEST submission/receipt and correction qualification. The existing opt-in ERiC
tests remain separate; skipped runs are not qualification evidence. No SDK,
developer registration, credentials or tax transmission was used here.

#15 remains open for broader legal forms and report variants: sole traders and
partnerships, special/supplementary balances, consolidated/interim/opening
reports and UKV are not enabled by this work. A separate commercial balance
with an official Überleitungsrechnung is not implemented; the supported
alternative is the reconciled Steuerbilanz. Industry-specific and tonnage-tax
attachments require their own official form implementation. Local XSD checks
are declaration-closure checks, not full XBRL formula/dimensions validation or
ERiC acceptance.

## Official sources

- [Official release index](https://www.esteuer.de/) (checked 15 October 2026).
- [Official 6.9 archive](https://www.esteuer.de/download/taxonomie_20250618/german-gaap-taxonomy-v6.9-2025-04-01-xbrl.zip).
- [Official 6.10 archive](https://www.esteuer.de/download/taxonomie_20260615/germany-gaap-taxonomy-v6.10-2026-04-01-xbrl.zip), downloaded and checksum-pinned here.
- [Official 6.10 change log](https://www.esteuer.de/download/taxonomie_20260615/Aenderungsnachweis_Tax_6.10.pdf).
- [EStG § 5b](https://www.gesetze-im-internet.de/estg/__5b.html).

The synthetic fixture checks both official archives and their XSD declarations;
it is app-generated synthetic evidence, not an official ELSTER sample or a
professional qualification certificate.
