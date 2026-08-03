# Narrow UG accounting scope and E2E proof

This is the supported product target for a German **UG (haftungsbeschränkt)**
with a small number of manual or imported receipts and bookings. It is a
product-boundary document, not tax or legal advice. Any missing, stale,
unsupported, or unreviewed fact blocks preparation or submission.

## Included workflow

1. Evidence-backed manual booking and DATEV/Lexware-style import.
2. UStVA and annual VAT preparation, validation, transmission lifecycle,
   immutable receipt, recovery, correction and idempotency.
3. MICRO/SMALL HGB annual accounts, evidence-backed independent workpaper
   review, annual-package approval and transactional ledger lock.
4. E-Bilanz lifecycle from the tenant's exact period data: versioned taxonomy
   evidence, complete mapping, canonical XBRL, validation/submission lifecycle
   and retained receipt.
5. KSt and GewSt preparation from a reconciled HGB/ledger/E-Bilanz result,
   documented versioned adjustments, prepared-dataset revalidation, durable
   submission workflow and receipt.

## Explicit exclusions

Payroll, invoices as a sales system, banking feeds, groups/consolidation,
foreign permanent establishments, partnerships, medium/large entities,
non-standard fiscal years, special accounting sectors, and Gewerbesteuer
Zerlegung/multiple establishments are outside this target. The annual tax
profile must have exactly one establishment for this narrow UG workflow;
otherwise the app requires Zerlegung data and does not claim a one-municipality
GewSt result.

An official ELSTER/ERiC acceptance cannot be asserted by the local Playwright
gateway. Production transmission remains blocked unless the qualified gateway,
form version and credentials are configured. The official-contract test is
opt-in and requires a real authorised test environment.

## Required no-mock browser proof suite

These tests must use the running application, isolated real SQLite database
and document storage. They must not use `page.route`, endpoint fulfilment, or
mocked accounting endpoints. A local gateway may prove app lifecycle behavior,
but is not evidence of ERiC interoperability.

| ID | Required proof | Current suite/status |
| --- | --- | --- |
| UG-BOOK-01 | Browser onboarding, receipt upload, manual double-entry booking, journal and statements; invalid input fails. | Required addition |
| UG-IMPORT-01 | Representative import creates evidenced journal records and idempotent re-import is rejected/unchanged. | Required addition |
| UG-UStVA-01 | Derive, validate, submit and retain/recover receipt; source change makes prepared result stale. | `tax-workflows-real.spec.ts` partially proves happy path |
| UG-UStAN-01 | Annual VAT reconciliation, validation, submission receipt and stale-source block. | `tax-workflows-real.spec.ts` partially proves happy path |
| UG-HGB-01 | UI-led reviewed close, package approval, READY_TO_LOCK, lock and post-lock booking rejection. | `annual-close-real.spec.ts` covers the lifecycle but still seeds setup through authenticated APIs |
| UG-HGB-02 | Missing/stale HGB evidence blocks lock. | `annual-close-real.spec.ts` |
| UG-EBILANZ-01 | Locked HGB package, complete taxonomy mapping, XBRL preparation, validation/submission receipt and stale-mapping block. | Required addition |
| UG-KST-01 | Reconciled KSt dataset, adjustment evidence, validation/submission receipt and stale-source block. | Required addition |
| UG-GEWST-01 | One-municipality/Hebesatz GewSt reconciliation, validation/submission receipt, and multiple-establishment block. | Required addition |
| UG-ELSTER-CONTRACT-01 | Opt-in official qualified test submission for every enabled form/version, archived redacted protocol. | External prerequisite; never run in default CI |

The existing local tax gateway is deliberately named a lifecycle emulator in
test reporting. It tests the real application integration and persistence, but
must never be described as successful ELSTER/ERiC interoperability.
