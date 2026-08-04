# DATEV adviser export boundary

The application exports a tenant- and fiscal-year-scoped `EXTF_Buchungsstapel_<year>.csv` using DATEV header version 700 and Buchungsstapel format version 13. The implementation follows DATEV's published file structure: an EXTF header, the format-defined column row, semicolon-separated records, CR/LF line endings, quoted/escaped text, comma decimal amounts, and no thousands separators.

The file contains all 125 format-13 booking columns. It uses UTF-8 with a byte-order mark, which DATEV documents as supported for manual import and `accounting:extf-files`. Every amount is serialized from integer ledger cents. Multi-line entries are deterministically decomposed into balanced debit/credit pairs. Already-posted explicit tax-account splits are retained; DATEV correction key `0040` suppresses automatic tax calculation on profit-and-loss splits so tax is not calculated a second time.

Each ledger snapshot produces an immutable, hash-addressed retained artifact with storage provenance and an audit event. Repeating an export without changing the ledger returns the same retained bytes.

Automated evidence:

- `src/core/datevExport.spec.ts`: deterministic byte format, 125 columns, UTF-8 BOM, exact VAT-cent round trip through the production DATEV parser, and fail-closed entry validation.
- `src/server/datevExport.persistence.spec.ts`: real SQLite, object storage, tenant isolation, retained-artifact idempotency, and audit provenance.
- `src/app/api/datev-export/[year]/route.spec.ts`: authenticated tenant scope and download integrity headers.
- `e2e/datev-adviser-real.spec.ts`: no-mock browser import, UI download, production-parser verification, and re-import.

Product boundary: DATEV states that complete CSV validation occurs in a DATEV application and requires interface sample files to be checked using its validation program. This repository cannot claim DATEV interface certification until its generated samples pass that proprietary validation/release process. Relevant primary documentation: [DATEV format overview](https://developer.datev.de/de/file-format/details/datev-format/format-description), [technical file construction](https://developer.datev.de/de/file-format/details/datev-format/getting-started), [header definition](https://developer.datev.de/de/file-format/details/datev-format/format-description/header), [booking batch definition](https://developer.datev.de/de/file-format/details/datev-format/format-description/booking-batch), [character set](https://developer.datev.de/de/file-format/details/datev-format/character-set), and [interface validation requirements](https://developer.datev.de/de/product-detail/accounting-extf-files/2.0/documentation/interface-requirements-file).
