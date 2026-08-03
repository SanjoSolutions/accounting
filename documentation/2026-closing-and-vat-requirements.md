# 2026 closing and VAT acceptance requirements

The following workflows are supported for the installed 2026 form and VAT-rule versions. Later filing years fail closed until their official mappings and rules are installed and qualified.

| ID | Requirement | Automated acceptance proof |
| --- | --- | --- |
| ACC26-01 | Review a balanced 2026 ledger, lock the fiscal year, retain the closing snapshot, and reject later postings. | `e2e/annual-close-real.spec.ts` |
| ACC26-02 | Create an evidenced taxable booking, reconcile January 2026 UStVA to the VAT control account, validate it through the configured gateway, submit it, and retain the receipt. | `e2e/tax-workflows-real.spec.ts` - `prepares, validates and submits the January UStVA with a durable receipt` |
| ACC26-03 | Reconcile the complete 2026 calendar year, prepare the annual VAT return, validate and submit the exact prepared dataset, and retain the receipt. | `e2e/tax-workflows-real.spec.ts` - `prepares, validates and submits the annual VAT return with a durable receipt` |

The Jahresabschluss workflow is an immutable mathematical ledger close with balance-sheet and profit-and-loss totals. Inventory, valuation, provisions, notes, tax reconciliation, and professional approval remain explicit professional responsibilities; the product does not claim to replace those statutory judgments.

The Playwright fixtures use isolated accounts and synthetic documents and bookings. They do not copy or reference the Lexware source export.
