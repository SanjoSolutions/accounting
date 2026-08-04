# Fixed-asset full sales

## Supported accounting contract

The supported sale is an evidenced, domestic EUR sale of one registered tangible fixed asset in full at the German standard 19% VAT rate. The asset must have a positive and identical HGB/tax carrying value, the sale date must fall in exactly one open fiscal year, and no later lifecycle event may already exist.

One database transaction posts and retains all of the following:

- one finalized tenant-customer sale document and gross debit open item tied to the gross trade-receivables journal line;
- net sale proceeds with canonical `DE_STANDARD` VAT facts and UStVA box 81 provenance;
- 19% output VAT;
- the exact carrying-value debit and asset-account credit;
- one immutable `DISPOSAL` event, sale evidence and actor-bound audit event.

The net book result is `net proceeds - carrying value`. The selected DATEV pair depends on that result:

| Chart | Result | Net proceeds | Carrying value |
| --- | --- | --- | --- |
| SKR03 | gain or break-even | 8820 | 2315 |
| SKR03 | loss | 8801 | 2310 |
| SKR04 | gain or break-even | 4845 | 4855 |
| SKR04 | loss | 6885 | 6895 |

The receivable/output-VAT controls are SKR03 1400/1776 or SKR04 1200/3806. Account-length scaling is applied to every number. The repository verifies active ownership, category and exact chart number for all five journal accounts inside the posting transaction. It also requires an active domestic tenant customer and atomically creates the finalized `CommercialDocument` plus `OpenItem`; a bare 1400/1200 control-account balance cannot be produced by this workflow. The selected customer's payment term determines the due date.

DATEV's official charts identify the account pairs and output-VAT controls in the [2026 SKR03 chart](https://www.datev.de/content/dam/markenassets/themen-und-produktgruppen/zielgruppen/mandant/unternehmer/branche/bau/11174%20SKR03%20BilrUg.pdf) and [2026 SKR04 chart](https://www.datev.de/content/dam/markenassets/themen-und-produktgruppen/zielgruppen/mandant/unternehmer/branche/bau/11175%20SKR04%20BilrUg.pdf). DATEV identifies both as valid for 2026 in its [current standard-chart registry](https://www.datev.de/web/de/berufsgruppenuebergreifend/service-und-support/wichtige-informationen-zum-jahreswechsel/jahreswechsel-rechnungswesen/anpassungen-in-den-programmen/DATEV-Kontenrahmen). A domestic supply for consideration is taxable under [UStG §1(1) no. 1](https://www.gesetze-im-internet.de/ustg_1980/__1.html), and the supported standard rate follows [UStG §12(1)](https://www.gesetze-im-internet.de/ustg_1980/__12.html).

## Fail-closed boundary

The workflow rejects partial sales, zero-proceeds disposals, fully depreciated non-monetary removals, tax/book divergence, special depreciation, rates other than 19%, exemptions, intra-EU/export cases, foreign currency, cash/bank settlement and later sale correction. A no-proceeds destruction or scrapping uses the separate full-retirement workflow. Unsupported sale cases require an adviser-approved manual workflow and are not represented as automatic fixed-asset sales.

## Automated proof

- `src/core/fixedAssets.spec.ts`: exact gain/loss, VAT/gross math and unsafe/unsupported input rejection.
- `src/server/fixedAssetsRepository.persistence.spec.ts`: migrated SQLite proof for both result branches, exact DATEV pairs, canonical VAT persistence, finalized customer receivable/open item, evidence, actor/tenant isolation, idempotency/concurrency, raw immutability and permanent lifecycle closure.
- `src/app/api/fixed-assets/[id]/sales/route.spec.ts`: authenticated write boundary, actor separation, read-only rejection before parsing and controlled malformed JSON.
- `e2e/fixed-assets-real.spec.ts`: no-route-mock visible customer creation, acquisition, depreciation, evidence upload, calculation preview, full sale, exact five-account journal, open-item subledger, reload and closure.
