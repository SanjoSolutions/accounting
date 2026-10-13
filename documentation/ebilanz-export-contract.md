# Authoritative E-Bilanz export contract (issue #36)

Implementation contract for #37's receiver adapters. This PR owns the dataset,
taxonomy selection, filing XML and reconciliation gates. Receiver adapters,
download UI and imported external evidence belong to #37.

The shared server entry point will be
`prepareAuthoritativeEBalanceExport(ownerId, fiscalYearId, options?)` in
`src/server/compliance/eBilanzExportRepository.ts`. It returns:

- `dataset`: versioned plain JSON, including tenant/fiscal period identity,
  exact `closeGenerationId`, effective company data, pinned taxonomy identity,
  uncondensed `accounts` with debit/credit cents, taxonomy-signed amounts and
  context, aggregated `facts`, approved reconciliation and asset disclosures.
- `datasetChecksum`, `xml`, `reportChecksum`, `officialArchive` and local
  `diagnostics`. These describe the same immutable dataset.
- An explicit validation level of `LOCAL_STRUCTURAL`; this is never ERiC
  validation or official acceptance.

Adapters must consume this dataset without querying or recalculating current
ledger data. Retention must preserve the dataset and exact output bytes; the
write transaction must recheck the close generation and reconciliation
fingerprint before publishing a version. Corrections append versions.

Reconciliation approval must explicitly identify the current close generation.
Missing, historical or incomplete evidence blocks a filing-ready export.
Zero differences require an explicit approved reconciliation, not an inferred
absence of adjustments. Asset taxonomy assignments and book/tax values must be
supported by evidence; unsupported cases fail closed.

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
