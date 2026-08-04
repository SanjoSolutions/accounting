# Narrow UG/GmbH accounting scope and E2E proof

This is the supported product target for a German **UG (haftungsbeschränkt) or GmbH**
with a small number of manual or imported receipts and bookings. It is a
product-boundary document, not tax or legal advice. Any missing, stale,
unsupported, or unreviewed fact blocks preparation or submission.

## Included workflow

1. Evidence-backed manual booking and DATEV/Lexware-style import.
2. Tenant-scoped customer/supplier master data and immutable receivable/payable
   open-item accounting with append-only settlement allocations and reversals.
3. Outgoing structured UBL invoice issuance with authoritative issuer master
   data, immutable canonical numbering, preview and original XML retention,
   plus idempotent accounting registration whose receivable, open item,
   revenue/output-VAT journal and tax-detail records are committed atomically;
   domestic 7%/19% partial credit notes and full cancellations post immutable
   reversing journals, VAT facts and explicit open-item netting.
4. Incoming PDF text extraction and EN-16931 UBL/CII/hybrid-PDF intake with
   explicit review and atomic supplier, payable, open-item, input-VAT and
   ledger posting. Structured facts remain authoritative and read-only. A
   deliberately narrow domestic §13b path accepts only whole-invoice `AE`
   evidence from German seller to German buyer, zero supplier VAT, gross and
   payable equal to net, an explicit §13b UStG reason on every line, an
   explicit user-confirmed 19% assessment, and explicitly configured active-
   chart input/output VAT control accounts. It posts equal recipient output
   VAT and deductible input VAT while leaving the supplier payable at net.
5. CAMT statement import, reviewed open-item matching, atomic payment posting,
   duplicate protection and append-only reversal.
6. UStVA and annual VAT preparation, validation, transmission lifecycle,
   immutable receipt, recovery, correction and idempotency.
7. MICRO/SMALL HGB annual accounts, evidence-backed independent workpaper
   review, annual-package approval and transactional ledger lock.
8. E-Bilanz lifecycle from the tenant's exact period data: versioned taxonomy
   evidence, complete mapping, canonical XBRL, validation/submission lifecycle
   and retained receipt.
9. KSt and GewSt preparation for calendar years 2025 and 2026 for UG/GmbH from
   a reconciled HGB/ledger/E-Bilanz result, documented year-versioned
   adjustments, prepared-dataset revalidation, durable submission workflow and
   receipt. The original 2025 UG rule identity remains backward compatible.
10. Evidence-bound fixed-asset registration, deterministic exact-cent monthly
    straight-line depreciation, atomic period journals, append-only full
    reversal, evidenced full retirement without proceeds, and evidenced domestic
    full sale at 19% VAT with DATEV result-specific gain/loss accounts. Registration verifies an existing posted, tenant-owned,
    evidence-linked asset debit for the exact account, amount and acquisition
    date; it deliberately does not create the supplier liability or cash entry.
11. Encrypted full-tenant backup download, isolated restore rehearsal,
    database/object-store fixity verification, atomic tamper rejection and
    retained restore certification.

## Explicit exclusions

Payroll, quotations/orders/delivery notes and recurring billing as a complete
sales system, live PSD2 banking feeds, groups/consolidation,
foreign permanent establishments, partnerships, medium/large entities,
non-standard fiscal years, special accounting sectors, and Gewerbesteuer
Zerlegung/multiple establishments are outside this target. The annual tax
profile must have exactly one establishment for this narrow capital-company workflow;
otherwise the app requires Zerlegung data and does not claim a one-municipality
GewSt result.

The §13b path does not decide whether the underlying supply or the recipient
meets the statutory conditions. The reviewer remains responsible for that
classification. Reduced-rate assessment, mixed ordinary/reverse-charge
invoices, foreign parties, missing statutory wording, nonzero supplier VAT,
and inferred/default control-account mappings fail closed. The supported
account numbers are tenant configuration, not software guesses. The statutory
basis for the recipient liability and possible deduction is [§ 13b
UStG](https://www.gesetze-im-internet.de/ustg_1980/__13b.html) and [§ 15
UStG](https://www.gesetze-im-internet.de/ustg_1980/__15.html); this product
boundary is not tax advice.

An official ELSTER/ERiC acceptance cannot be asserted by the local Playwright
gateway. Production transmission remains blocked unless the qualified gateway,
form version and credentials are configured. The official-contract test is
opt-in and requires a real authorised test environment.

Outgoing invoices use XRechnung 3.0.2 UBL. The dedicated CI contract downloads
the pinned official KoSIT validator 1.6.2 and 2026-01-31 XRechnung rules,
verifies both downloaded artifacts against fixed SHA-256 digests, validates a
freshly generated invoice, parses the exact VARL `valid`, validation-step,
assessment, engine, scenario and document-digest semantics, proves a required-
field-invalid invoice is explicitly rejected, and retains both XML and HTML
reports.
Changing the profile, generator, validator, or rules must keep that gate green.
Buyer Reference and the electronic delivery address are independent fields;
the buyer endpoint supports the explicitly validated `0204` Leitweg-ID, `9930`
German VAT-ID and `EM` email schemes, so a public buyer does not need a VAT ID.
`0204` input must also pass the official Leitweg-ID shape and Modulo-97 checksum
before an immutable invoice number is allocated.

## Required no-mock browser proof suite

These tests must use the running application, isolated real SQLite database
and document storage. They must not use `page.route`, endpoint fulfilment, or
mocked accounting endpoints. A local gateway may prove app lifecycle behavior,
but is not evidence of ERiC interoperability.

| ID | Required proof | Current suite/status |
| --- | --- | --- |
| UG-BOOK-01 | Browser onboarding, receipt upload, manual double-entry booking, journal and statements; invalid input fails. | `ug-bookkeeping-real.spec.ts` proves the no-mock UI workflow with isolated credentials, real storage/database, unbalanced-input rejection, reload and retained journal evidence |
| UG-PARTNER-01 | Create tenant-scoped customer/supplier master data through visible UI and retain it across reload. | `commercial-real.spec.ts` proves isolated credential onboarding, navigation, customer creation and reload without route interception or API/database seeding |
| UG-RBAC-01 | Separate the human actor from the active company, provide administrator/accountant/read-only roles, isolate unassigned tenants, audit every role change, and preserve zero-configuration localhost solo use. | `roles-real.spec.ts` uses two independently authenticated browser contexts and visible Users/settings/compliance pages to grant read-only access, select the assigned company, read its settings, and prove real HTTP 403 denials for both compliance-period and malformed tax-workflow mutations without route interception or mocked gateways. The central mutation-boundary policy and its filesystem-scanning BDD classify every non-GET API method and server action, fail when a new mutation is unclassified or its authorization guard occurs after request parsing, reserve access administration for administrators, and explicitly inventory side-effecting reads. Route BDD covers settings, journals, documents/payables, commercial documents/partners/settlements, banking, assets, DATEV, tax, e-balance, compliance, HGB close, reminders and corrections; unknown roles fail closed. `tenantAccess.persistence.spec.ts`, audit-chain persistence, access/settings API BDD, authentication and authorization suites prove tenant isolation, separate active-company and immutable human-actor attribution, audited grant/change/revoke, owner protection and forged-cookie fallback. `pnpm solo`/`pnpm dev:local-solo` remains the easy localhost-only no-auth path and returns its implicit local administrator without consulting session or membership persistence. |
| UG-OPOS-01 | Receivable/payable invoices, partial/final/split allocation, retained overpayment credit, complete reversal, concurrency safety and tenant isolation. | `structured-invoices-real.spec.ts` proves outgoing invoice-to-open-item persistence; `incoming-invoice-posting-real.spec.ts` proves reviewed supplier invoice-to-payable posting; `banking-real.spec.ts` proves both a real partial receipt and a €250 receipt visibly split over two €119 invoices with €12 retained customer credit, reload, duplicate retry, append-only reversal and reopened balance. Migrated-SQLite BDD additionally proves later application of retained credit to a third invoice and one reconciliation reversal unwinding all allocations exactly; repository/API suites prove exact-cent bounds, same-partner/direction/currency scope, idempotency, races, read-only denial and tenant isolation |
| UG-UBL-01 | Configure issuer/profile and numbering, issue an outgoing XRechnung UBL invoice, preview/download the retained XML, atomically post receivable/revenue/output VAT and reload it. | `structured-invoices-real.spec.ts` proves the entire visible UI journey, official profile IDs, buyer reference, electronic endpoints, seller contact, open item and visible 1400/8400/1776 journal; migrated-SQLite tests prove canonical VAT detail plus exact mixed 7%/19% account groups and rollback for unsupported foreign VAT cases |
| UG-CREDIT-01 | Issue a partial credit note or full cancellation against a posted outgoing invoice and atomically reverse revenue/output VAT/receivables while netting the original and preserving any customer credit. | The structured-invoice correction Playwright journey proves visible original issuance, partial credit, reversing journal, open-item netting and reload; BDD, API and migrated-SQLite tests prove 7%/19%, full/partial and prior-payment balances, immutable lineage, negative VAT provenance, concurrency and rollback. Replacement-style corrections and unsupported VAT/geography fail closed |
| UG-XRECHNUNG-CONTRACT-01 | Generated profiles pass the official KoSIT validator with retained validation reports. | `xrechnung.contract.spec.ts` passes SHA-256-pinned KoSIT validator 1.6.2 with SHA-256-pinned XRechnung 3.0.2 rules dated 2026-01-31 for public 0204 Leitweg-ID, business 9930 VAT-ID mixed 7%/19%, and EM email endpoint invoices; it binds the VARL report digest to exact generated bytes, requires explicit accept semantics at every step and proves an invalid fixture is explicitly rejected; the `xrechnung-contract` CI job retains every official XML/HTML report |
| UG-IMPORT-01 | Representative import creates evidenced journal records and idempotent re-import is rejected/unchanged. | `lexware-2025-reports.spec.ts` proves evidenced Lexware import and unchanged idempotent re-import; `datev-adviser-real.spec.ts` proves an exact-cent DATEV import/export/re-import round trip without mocked routes |
| UG-BANK-01 | Import a CAMT statement, review exact/partial/split matches, retain overpayment as partner credit, atomically allocate open items and ledger, survive retry/reload, then reverse append-only. | `banking-real.spec.ts` proves no-mock partial and split-overpayment UI workflows with a single exact bank journal, two settled invoices and visible durable credit. BDD and migrated-SQLite suites prove parsing, credit reuse, complete multi-allocation reversal, exact-cent limits, same-partner scope, tenant isolation and concurrency |
| UG-AP-INVOICE-01 | Review a PDF or structured supplier invoice and atomically create supplier, payable document, open item, expense/input-VAT/payables journal, canonical VAT detail and evidence links. | `incoming-invoice-posting-real.spec.ts`, `structured-incoming-payable-real.spec.ts` and `structured-incoming-cii-hybrid-real.spec.ts`, plus route BDD and migrated-SQLite persistence tests, prove PDF/UBL/CII/hybrid intake, immutable structured facts, 0%/7%/19% and mixed-rate SKR03/SKR04 control accounts, rollback, idempotency and tenant isolation |
| UG-AP-13B-01 | Configure exact active-chart §13b controls, review a genuine domestic UBL `AE` supplier invoice, explicitly confirm 19%, and atomically retain a net payable, equal recipient output/input VAT, canonical return-box provenance and immutable evidence. Unsupported or ambiguous cases must leave no accounting residue. | `reverse-charge-payable-real.spec.ts` proves the no-mock visible SKR03 configuration/upload/review/confirmation/journal/reload journey. Domain, settings/API and migrated-SQLite BDD prove exact 19%, explicit SKR03/SKR04 mappings, canonical boxes 84/85/67, idempotency, rollback and tenant isolation; 7%, third-country, mixed, vague and unconfigured cases fail closed. |
| UG-AP-13B-EU-SERVICE-01 | For EUR B2B services from a supplier established in another current EU member country, require a German business buyer whose VAT ID exactly matches the tenant company profile, a syntactically matching supplier VAT ID, whole-invoice EN16931 `AE`, zero supplier VAT, an exact supply date, an explicit §13b(1) or Article 196 reverse-charge reason, explicit operator classification as `SERVICE`, explicit 19%, and configured active-chart input/output controls. Preserve a net payable while posting equal recipient output/input VAT with distinct UStVA provenance KZ 46/47/67 in the supply-date period. | `eu-supplier-service-reverse-charge-real.spec.ts` proves the visible no-mock configuration, UBL upload, review, explicit service/rate confirmation, cross-month supply-date tax point, journal, evidence, API VAT provenance and reload journey. BDD domain/API/UI and migrated-SQLite persistence tests prove current-EU-country allowlisting (excluding DE and third countries), description-independent classification, supply-date period selection, VAT-ID supplier identity and address snapshot, balance, durable evidence/audit, exact canonical-command replay including race recovery, tenant isolation, and zero-residue fail-closed buyer mismatch or missing/wrong facts. The legal classification is pinned to [§ 3a(2) UStG](https://www.gesetze-im-internet.de/ustg_1980/__3a.html), [§ 13b(1) and (5) UStG](https://www.gesetze-im-internet.de/ustg_1980/__13b.html), [Article 196 VAT Directive](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A02006L0112-20250414), and the [official BMF 2026 UStVA form and instructions](https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Umsatzsteuer/2025-12-29-vordruckmuster-USt-voranmeldung-2026.pdf?__blob=publicationFile&v=7). |
| UG-DUNNING-01 | Issue sequential reminders only for overdue finalized customer receivables, retain immutable printable snapshots, explicitly approve delivery to a typed customer email, and cancel append-only without changing the balance. | `receivables-reminders-real.spec.ts` proves issue/print/download, blank non-inferred recipient review, explicit operator approval, real HTTP delivery through a local capturing gateway, recipient/subject/safe hash-bound HTML attachment, provider message ID, reload/cancel and unchanged open balance without route interception. BDD, migrated-SQLite/API and raw-trigger tests prove tenant/actor/RBAC scope, attempt/result immutability and audit, provider idempotency under concurrency, safe HTTPS/loopback configuration, failure plus new-attempt retry, sequential issue, draft rejection and no open-item mutation. Court collection remains external. |
| UG-ASSET-01 | Capitalize an evidenced acquisition, bind it to the asset register, calculate an exact-cent monthly HGB schedule, post depreciation atomically, and dispose of a partially depreciated asset through either an evidenced full domestic sale at 19% VAT or a full retirement without proceeds. | Both no-route-mock scenarios in `fixed-assets-real.spec.ts` visibly post the acquisition debit, bind the exact unused line, post depreciation, upload separate disposal evidence and prove closed persistence plus immutable journals after reload. The sale scenario also creates the customer visibly and proves the finalized gross open item, output VAT, exact carrying-value derecognition and DATEV 2026 SKR03 8820/2315 book-gain accounts. BDD, API and migrated-SQLite/raw-trigger tests additionally prove atomic CommercialDocument/OpenItem creation instead of a bare 1400/1200 balance, the SKR03 8801/2310 loss pair, SKR04 4845/4855 gain and 6885/6895 loss pairs, canonical VAT box-81 facts, exact result math, evidence/tenant/actor binding, idempotency, concurrency, audit history, and permanent blocking of later depreciation/reversal. Partial sales, non-19%/exempt/cross-border sales, sale corrections, fully-depreciated non-monetary retirement, special tax depreciation and deferred-tax divergence fail closed; see `fixed-asset-sales.md`. |
| UG-BACKUP-01 | Download an encrypted full-tenant backup, restore it into isolated migrated storage, verify database/object fixity, reject tampering atomically and certify the restore. | `backup-restore-operations-real.spec.ts` proves the operator-visible no-mock workflow with representative journals, documents, open items, banking, extraction, reminders, fixed assets, VAT and tax metadata; BDD/API/full-graph tests prove registry completeness and tampered-ciphertext 409 with unchanged manifest |
| UG-UStVA-01 | Derive, validate, submit and retain/recover receipt; source change makes prepared result stale. | `tax-workflows-real.spec.ts` proves preparation, local lifecycle validation/submission and durable receipt, plus stale-source blocking after a real second-tab booking changes the ledger |
| UG-UStAN-01 | Annual VAT reconciliation, validation, submission receipt and stale-source block. | `tax-workflows-real.spec.ts` proves the corresponding annual workflow and real stale-source block |
| UG-HGB-01 | UI-led reviewed close, package approval, READY_TO_LOCK, lock and post-lock booking rejection. | `annual-close-real.spec.ts` now transacts account creation, cross-user access, retained evidence, year-bounded historical profile/mapping onboarding, ledger posting, every applicable typed workpaper, preparation, independent review, annual-package creation/approval, signatures, evaluation and locking through visible pages and page models. The close workbench exposes only tenant/period-scoped approved annual packages and binds the selected immutable package ID and checksum into evaluation; BDD component, route and repository tests prove fail-closed validation. |
| UG-HGB-02 | Missing/stale HGB evidence blocks lock. | `annual-close-real.spec.ts` |
| UG-EBILANZ-01 | Locked HGB package, complete taxonomy mapping, XBRL preparation, validation/submission receipt and stale-source block. | `annual-close-real.spec.ts` consumes the authoritative year-effective profile, proves a real user-visible report-source change immediately labels the prior version `STALE` and blocks official processing, then regenerates/revalidates a retained v2 package that remains durably bound to the exact current close generation after reload. BDD repository/UI/API tests prove only the newest version of that exact generation can be `CURRENT`; unbound, superseded, or stale-generation reports fail closed. Official ERiC validation/submission and its receipt remain an external qualification prerequisite |
| CAPITAL-KST-01 | Reconciled 2025/2026 UG/GmbH KSt dataset, adjustment evidence, validation/submission receipt and stale-source block. | `annual-close-real.spec.ts` proves both the 2025 UG regression and 2026 GmbH lifecycle through the local emulator and blocks submission after a real second-tab evidenced adjustment makes the prepared dataset stale; versioned domain/repository tests prove all four legal-form/year combinations; official interoperability remains required |
| CAPITAL-GEWST-01 | One-municipality/Hebesatz 2025/2026 UG/GmbH GewSt reconciliation, validation/submission receipt, and multiple-establishment block. | `annual-close-real.spec.ts` proves 2025 UG and 2026 GmbH one-municipality lifecycles; authoritative BDD and database-constraint tests prove multiple establishments and unsupported fiscal shapes fail closed; official interoperability remains required |
| UG-ELSTER-CONTRACT-01 | Opt-in official qualified test submission for every enabled form/version, archived redacted protocol. | `qualified-tax-gateway.contract.spec.ts` and its environment-approved manual workflow fail closed unless all eight enabled 2025/2026 form versions validate, reject an invalid dataset, return accepted TEST/STAGING submission evidence and replay the identical submission to the same protocol identity and receipt digest; JSON and non-JSON responses retain bounded redacted fixity evidence. Execution and provider-schema approval remain external prerequisites; a skip is explicitly not evidence |
| UG-DISCLOSURE-CONTRACT-01 | Opt-in official Unternehmensregister Webservice validation and non-binding acceptance for micro-entity Hinterlegung and small-entity Offenlegung, with archived redacted protocols. | `qualified-disclosure-gateway.contract.spec.ts`, BDD configuration/protocol tests and the protected manual workflow require the provider-issued schema, electronically identified submitter, exact qualification identity, invalid-package rejection, retained TEST/STAGING receipt and same-identity/digest replay for both supported cases; JSON and non-JSON responses retain bounded redacted fixity evidence. Provider access and the reviewed application-package-to-provider-schema transformer remain external prerequisites; a skip is explicitly not evidence |

The existing local tax gateway is deliberately named a lifecycle emulator in
test reporting. It tests the real application integration and persistence, but
must never be described as successful ELSTER/ERiC interoperability.
