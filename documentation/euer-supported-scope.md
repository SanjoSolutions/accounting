# EÜR preparation for sole traders

Related issue: https://github.com/SanjoSolutions/accounting/issues/27

The company profile explicitly selects balance-sheet accounting or EÜR and distinguishes commercial from self-employed income. EÜR requires confirmation that neither statutory nor voluntary balance-sheet accounting applies. This choice is independent of the VAT regime; issue #28 owns small-business VAT eligibility.

The tax workspace links to an EÜR workpaper for calendar years 2025 and 2026. Users enter actual payments with source references and classify net receipts, received/paid VAT, ordinary deductible expenses and cash owner transfers. Refunds are negative amounts. Owner transfers are reported separately and do not change profit. The optional regularly recurring payment classification requires a due date and economic year; cross-year treatment requires both payment and due date in the ten-day window under §11 EStG. Direct-debit timing and other special legal cases require separate review.

This is manual preparation: there is no automatic import or reconciliation with the journal, no income-tax calculation, and no ELSTER/ERiC transmission. A reviewed CSV and the saved transfer overview provide year-specific line numbers and field codes. The income tax return and any required trade tax return are separate. Drafts cannot be exported until completeness and the supported scope are confirmed.

The supported scope excludes assets and depreciation/AVEÜR, noncash private use, restricted deductions, debt-interest/SZ calculations, reserves, profit adjustments, business cessation, accounting-method changes, farming, partnerships, multiple businesses in one workpaper and other special cases. Users must not confirm completeness when any excluded case applies.

Saves append immutable revisions, retain the actual actor in the audit chain and use an optimistic base version plus an idempotent request key. Locked fiscal years reject new revisions. A changed authoritative full-year company profile invalidates export until review and a new save. Tenant backups include the revisions.

## Official basis

- [EStG §4(3)](https://www.gesetze-im-internet.de/estg/__4.html)
- [EStG §11](https://www.gesetze-im-internet.de/estg/__11.html)
- [ELSTER 2025 EÜR instructions](https://www.elster.de/elsterweb/helpGlobal?themaGlobal=help_euer_ufa_77_2025)
- [BMF Anlage EÜR 2025](https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Einkommensteuer/2025-08-29-anlage-EUER-2025.html)
- [BMF Anlage EÜR 2026](https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Einkommensteuer/2026-09-01-anlage-EUER-2026.html)

Both BMF PDFs were downloaded from the ministry and visually checked. In particular, goods move from line 27 in 2025 to line 29 in 2026; most later expense lines move by one. These are manual-copy form mappings, not a qualified electronic submission schema.

## Reproducible browser verification

`node node_modules/@playwright/test/cli.js test --config playwright.euer.config.ts`

The config refuses server reuse. Its launcher checks that port 3227 is free and verifies `euer-playwright.db` and `.playwright/euer-documents` before preparing the disposable database. It applies all SQL migrations and uses synthetic local-solo data. It never targets port 3000 or the company database.
