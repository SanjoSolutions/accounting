# Authoritative E-Bilanz export contract (issue #36)

Implementation contract for #37's receiver adapters. This PR owns the dataset,
taxonomy selection, filing XML and reconciliation gates. Receiver adapters,
download UI and imported external evidence belong to #37.

The shared server entry point is
`prepareAuthoritativeEBalanceExport(ownerId, fiscalYearId, options?)` in
`src/server/compliance/eBilanzExportRepository.ts`. It returns:

- `dataset`: versioned plain JSON, including tenant/fiscal period identity,
  exact `closeGenerationId`, effective company data, pinned taxonomy identity,
  uncondensed `accounts` with debit/credit cents, taxonomy-signed amounts and
  context, aggregated `facts`, approved reconciliation and asset disclosures.
- `datasetChecksum`, `xml`, `reportChecksum`, `officialArchive` and local
  `diagnostics`, plus `evidenceChecksum`. These describe the same immutable dataset.
- An explicit validation level of `LOCAL_STRUCTURAL`; this is never ERiC
  validation or official acceptance.

Adapters must consume this dataset without querying or recalculating current
ledger data. Retention must preserve the dataset and exact output bytes; the
write transaction must recheck the close generation and reconciliation
fingerprint with `assertCurrentEBalanceExport(transaction, ownerId, prepared)`
before publishing a version. Corrections append versions. The XML contains only
official taxonomy facts and a non-semantic dataset SHA-256 comment; the comment
keeps a corrected approval distinct even if the resulting monetary facts match.
`serializePreparedEBalanceEvidence(prepared)` is the retained JSON envelope.

Reconciliation approval must explicitly identify the current close generation.
Missing, historical or incomplete evidence blocks a filing-ready export.
Zero differences require an explicit approved reconciliation, not an inferred
absence of adjustments. Asset taxonomy assignments and book/tax values must be
supported by evidence; unsupported cases fail closed.

Approve with `recordTaxBalanceReconciliation(ownerId, actorId, input)` or the
existing authenticated `reconciliation.record` operation using `kind: TAX_BALANCE`.
Input includes `fiscalYearId`, `reason`, `evidenceIds` and `payload` conforming to
`EBalanceTaxBalanceEvidence` in `src/core/eBilanzExport.ts`. The server supplies
the source/evidence checksums, approver and timestamp; the caller must supply
the exact reviewed `closeGenerationId`. Payload fields are:

- `schemaVersion: EBILANZ_TAX_BALANCE_V1`, `complete: true`;
- `adjustments`: balanced tax-only debit/credit journal lines against snapshot
  account IDs, with a description and evidence IDs; explicit `[]` for no differences;
- `assetMappings`: each asset ID to a fixed-asset ledger account ID;
- `bvv`: opening equity, capital adjustments, contributions and distributions in cents;
- `gcd`: business activity matching the effective company profile, country `DE`,
  house number, exact previous period (or explicit null), shareholder identities
  and ownership fractions, business identifier, `domesticOrdinaryCompany: true`;
- `nilReasons`: documentary reasons for unavailable company/shareholder identifiers.

This supports ordinary domestic UG/GmbH, GKV, individual annual tax balances
before appropriation. Special/supplementary/consolidated/interim/UKV reports
fail closed. The tax journals describe tax-balance differences, not off-balance
KSt/GewSt add-backs. All used accounts in the locked snapshot are retained,
including inactive and zero-net accounts with turnover; credits against debit
concepts remain negative. The tax asset movement schedule is emitted as BAL
(gross Anlagenspiegel); individual book/tax asset records remain in the JSON
companion and are not mislabelled as an official AV taxonomy report.

The current exporter selects from the reviewed source registry, independently
of the legacy administrator-uploaded taxonomy records. Uploading an archive does
not establish official applicability or receiver availability.

Local validation checks the pinned official archive, namespace-aware XML,
context/entity/period/unit consistency, applicable mandatory KSt/GKV concepts,
and exact dataset equality. `libxml2-wasm@0.7.1` performs real XSD validation
against the **declaration closure used by the instance**: unused global taxonomy
elements are removed from in-memory schema copies to avoid libxml2's excessive
tuple-substitution compilation. Retained declarations, references, types and
constraints are unchanged; this restricts the schema language. Packaged official
schema bytes are unchanged. This is not a full XBRL formula/dimensions processor
or an ERiC business-rule/receiver acceptance test.

The imported XBRL base schemas are offline and pinned in
`public/taxonomies/xbrl-base-schemas.zip`; the adjacent JSON records each official
source URL and content digest. Updating them requires downloading those public
URLs, checking each digest and reviewing the archive pin in
`eBilanzSchemaValidation.ts`. Validation never fetches schemas from the network.

This shared preparation path does not require ERiC credentials or gateway
qualification. Existing direct-submission qualification gates stay separate.
Internal canonical evidence XML is not an official filing instance.

Taxonomy 6.9 is the verified 2026 baseline. Its bundled official archive matches
the freshly downloaded official bytes (SHA-256
`accd62202d73c036910fee118b30730f0392934afc9730617788e30a0480df87`).
Taxonomy 6.10 is legally permitted for 2026, but its announced test/live dates
are November 2026/May 2027. A publication or future date alone cannot establish
receiver availability.

Sources checked on 13 October 2026:

- [Official release index](https://www.esteuer.de/)
- [Official 6.9 archive](https://www.esteuer.de/download/taxonomie_20250618/german-gaap-taxonomy-v6.9-2025-04-01-xbrl.zip)
- [BMF 10 June 2025](https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Einkommensteuer/2025-06-10-ebilanz-taxonomien-6-9.pdf?__blob=publicationFile&v=4)
- [BMF 8 June 2026](https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Einkommensteuer/2026-06-08-ebilanz-taxonomien-6-10.pdf?__blob=publicationFile&v=4)
