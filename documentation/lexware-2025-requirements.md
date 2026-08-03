# Lexware 2025 requirement baseline

This baseline was derived from the structure and aggregate record counts of the
2025 fiscal-year tables in the supplied Lexware `Daten Betriebsprüfung`
export. It intentionally contains no company names, addresses, document names,
account labels, booking text, identifiers, or monetary values from that export.
Test fixtures use invented data.

Empty 2025 tables do not establish an active-use requirement. Cost centers and
the fixed-asset register are therefore outside this baseline; both can be added
later if schema parity, rather than demonstrated 2025 use, becomes the target.

| ID | Demonstrated 2025 capability | Acceptance evidence |
| --- | --- | --- |
| LEX25-01 | Import company and accounting setup: EUR, determination method, SKR-03, calendar fiscal year, and taxonomy version | Playwright imports an anonymized GDPdU folder and the reports workspace shows its setup |
| LEX25-02 | Preserve and search the chart with category, subtype, VAT, EÜR, HGB, and taxonomy mappings | Playwright searches the imported chart and verifies its accounting mappings |
| LEX25-03 | Import and review balanced journal postings with booking/voucher dates, numbers, descriptions, periods, and VAT split lines | Playwright opens the fixed 2025 journal and verifies a multi-line posting |
| LEX25-04 | Archive, link, open, and retrieve PDF vouchers while permitting postings without a voucher | Playwright opens an imported PDF from the journal and verifies an unattached posting remains visible |
| LEX25-05 | Review a trial balance with opening, annual, cumulative, and closing debit/credit values and last-booking dates | Playwright verifies an imported trial-balance row |
| LEX25-06 | Review general-ledger account sheets with counter-account, voucher metadata, debit/credit, and VAT information | Playwright drills into an account sheet and verifies a posting line |
| LEX25-07 | Review debtor and creditor subledgers and their balanced posting activity | Playwright verifies both an anonymized debtor and creditor account |
| LEX25-08 | Preserve and review debtor/creditor address master data including party number, address, and industry | Playwright verifies an anonymized counterparty address |
| LEX25-09 | Review the imported annual German VAT statement fields | Playwright verifies populated VAT assessment and tax fields |
| LEX25-10 | Accept the GDPdU/GoBD folder structure, legacy Windows encoding, tabular schemas, and safe document links idempotently | Playwright imports the same anonymized folder twice and verifies that the second import skips existing bookings |

## Aggregate source evidence

The 2025 export contains one company record, 1,211 chart rows, 94 distinct
journal bookings across all twelve periods, 31 trial-balance rows, 154
general-ledger rows, 44 debtor/creditor subledger rows, five counterparty
addresses, one annual VAT record, and 63 linked PDF vouchers. VAT split
postings are populated. The cost-center and fixed-asset tables have no 2025
records.
