# Kleinunternehmerregelung (§19 UStG)

Issue: https://github.com/SanjoSolutions/accounting/issues/28

The VAT regime is independent of legal form. Select `SMALL_BUSINESS` in the authoritative company profile and confirm its effective date. New domestic EUR sales from 2025 use category E, zero VAT, and the notice “Steuerbefreiung für Kleinunternehmer gemäß § 19 UStG.” Select §19 exempt in the invoice editor. The server checks the profile effective on the supply date. A tax number suffices; an invoice issuer without a VAT ID uses its contact email as the XRechnung electronic address.

Exempt sales use SKR03 account 8192 or SKR04 account 4184. Ordinary supplier VAT remains part of the expense, with no input VAT deduction. Recipient-assessed tax remains payable, without an offsetting input deduction. Corrections retain the original invoice's treatment across later profile changes. Existing immutable evidence is preserved.

Routine VAT advance and annual returns are not applicable to a small-business profile. Documented applicability overrides can record exceptional obligations. The standard annual VAT dataset intentionally rejects small-business returns: a tax-office request or a §18(4a) liability needs a separately reviewed special return. Recording recipient tax does not submit a return.

## Eligibility and scope

The user confirms eligibility and updates the dated profile when the exemption ends. The application does not automatically determine or monitor statutory turnover. Under §19(2), turnover is based on receipts and statutory exclusions, not simply issued invoice totals. From 2025 the prior-year limit is EUR 25,000 and the current-year limit EUR 100,000. In the first year the applicable limit is EUR 25,000. The transaction crossing the current-year limit is already taxable. A waiver binds for at least five calendar years.

Historical periods before 2025, the EU cross-border small-business scheme under §19a, special annual returns, mixed use/input-tax adjustment under §15a and automatic qualification are outside this implementation. Unsupported outgoing foreign and mixed taxable/exempt invoices are rejected. Sole-proprietor/EÜR reporting is owned by issue #27.

## Official references checked on 15 October 2026

- [§19 UStG](https://www.gesetze-im-internet.de/ustg_1980/__19.html): exemption, receipts-based turnover, limits, waiver, filing exceptions.
- [§15 UStG](https://www.gesetze-im-internet.de/ustg_1980/__15.html): input deduction exclusion.
- [§34a UStDV](https://www.gesetze-im-internet.de/ustdv_1980/__34a.html): invoice requirements and exemption notice.
- [BMF letter of 18 March 2025](https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Umsatzsteuer/Umsatzsteuer-Anwendungserlass/2025-03-18-sonderregelung-kleinunternehmer.html): effective rules, first-year limit and recipient liabilities.
- [DATEV chart changes 2024/2025, SKR03](https://apps.datev.de/help-center/api/knowledge-help/v1/content/entities/st45388526219_de.pdf?docId=1029365&save=False): post-reform revenue accounts.

## Isolated verification

`playwright.small-business.config.ts` owns port 3228, `issue-28-playwright.db`, and `.playwright/issue-28-documents`; it refuses reuse of an existing server. Tests use synthetic data. The live company instance on port 3000 is never used. Run expensive verification under the shared Windows mutex `Local\CodexAccountingHeavyVerification`.

The initial publication is a draft. Complete the final full unit suite, production build, browser journey and required Codex 5.6-Sol visual review before marking ready.
