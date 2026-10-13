# E-Bilanz 2026: filing route and cost decision

Researched by Codex on **13 October 2026** for [#39](https://github.com/SanjoSolutions/accounting/issues/39). Prices are a dated snapshot, not a quote for filing in 2027. No provider account, paid product, certificate, test transmission or live submission was used. Receiver compatibility below means documented capability; this research did not qualify an application-generated package.

## Decision

**Target myebilanz BASIS first:** an exported balance CSV plus complete text configuration gives the lowest provider cash cost, **EUR 0**, and keeps preparation local. Its paid PLUS edition is optional. Deliver and verify the adapter in [#37](https://github.com/SanjoSolutions/accounting/issues/37) against the authoritative 2026 dataset from [#36](https://github.com/SanjoSolutions/accounting/issues/36). Until that verification exists, this is the recommended implementation target, not a claim that today's download is import-ready. [myebilanz overview](https://www.myebilanz.de/000-was-ist-myebilanz.php)

If BASIS configuration takes too much owner time, use **myebilanz PLUS for EUR 34.95 net / 41.59 gross** for the applicable balance date. If local installation or that receiver's supported scope is unsuitable, use **eBilanz+ through its web UI**, EUR 35 net / 41.65 gross, with corrections covered under the conditions below. For an XBRL-import workflow, **eBilanz-Online** is a documented fallback at EUR 39 net / 46.41 gross per transmission. A ZIP containing schemas is not itself a promised import format. [PLUS](https://www.myebilanz.de/075-plus-funktionen.php), [eBilanz+ prices](https://ebilanzplus.de/kosten), [eBilanz-Online prices](https://www.ebilanzonline.de/preismodell/), [XBRL import](https://www.ebilanzonline.de/wissen/faq/importmoeglichkeiten/xbrl-datei/)

**Sanjo Solutions can apply for direct ERiC developer access.** Approval is discretionary; ERiC itself is free. No mandatory paid commercial gateway or paid certification was evidenced by the public ELSTER material. Direct integration nevertheless needs engineering and actual-output qualification. It is not the cheapest use of development time for one annual return. The [direct-ERiC plan](./eric-direct-qualification-plan.md) records the remaining work, inaccessible terms and a registration draft.

## Cost assumptions

- One UG, one original annual E-Bilanz for each fiscal year beginning with 2026; the correction scenario adds one correction of that same year's original **each year**. An opening balance is not substituted for the annual filing.
- All amounts are EUR. Each table cell is **net / gross**, using 19% VAT for these commercial services, rounded per purchase to cents. Gross is cash paid; net is shown separately without assuming the UG's input-VAT entitlement. Future prices and VAT are held constant for comparison.
- Existing computer/internet, owner time, engineering, accounting preparation, taxes, register charges and paid professional services are excluded. Direct ERiC's zero is software/transmission fees, not total cost of ownership.
- No promotional discounts. Annual PLUS licenses are bought separately. Ordinary web filing uses pay-as-you-go; prepaid alternatives are explicit. No initial balance of unused credits is assumed.

### One annual filing, including its correction

| Route | Original annual filing | Extra correction | Original + one correction | Setup / recurring commitment |
| --- | ---: | ---: | ---: | --- |
| myebilanz BASIS | 0 / 0 | 0 / 0 | 0 / 0 | No paid license or subscription; local setup and INI mapping |
| myebilanz PLUS | 34.95 / 41.59 | 0 / 0 within the licensed date band | 34.95 / 41.59 | One license per annual balance-date band; no subscription |
| eBilanz+ web UI | 35.00 / 41.65 | 0 / 0 if original filed there | 35.00 / 41.65 | No mandatory subscription or setup charge |
| eBilanz-Online web UI | 39.00 / 46.41 | Budget 39.00 / 46.41* | Budget 78.00 / 92.82* | Prepaid credits; no subscription or fixed account charge |
| Direct ERiC | 0 / 0 software fee | 0 / 0 software fee | 0 / 0 software fee | Developer approval and ongoing self-maintenance; terms still to verify |

myebilanz permits repeated transmissions within a licensed PLUS date band. Choose by the **actual closing date**, not the date the return is sent: its documented example bands run from 31 December through 30 December of the following year. Confirm the selector covers **31 December 2026**, or the actual short-year closing date, before any purchase. [PLUS license scope](https://www.myebilanz.de/075-plus-funktionen.php)

eBilanz+ charges only successful web transmission. Preserve the original provider case for its correction linkage; changing the fiscal period can require provider intervention. [Correction conditions](https://ebilanzplus.de/faq/korrekturen/wann-ist-eine-korrektur-kostenlos), [original-filing condition](https://ebilanzplus.de/kosten)

\* eBilanz-Online says each successful E-Bilanz transmission consumes a credit. Its free-correction statement appears under **Offenlegung/DiFin**, not E-Bilanz. A free E-Bilanz correction was not verified; the table conservatively budgets a second credit, rather than promising a waiver. Failed validations are not charged. [Price model](https://www.ebilanzonline.de/preismodell/)

### Cumulative cash outlay: 1 / 3 / 5 annual filings

| Route | 1 year | 3 years | 5 years | With one correction every year |
| --- | ---: | ---: | ---: | --- |
| myebilanz BASIS | 0 / 0 | 0 / 0 | 0 / 0 | Same totals |
| myebilanz PLUS | 34.95 / 41.59 | 104.85 / 124.77 | 174.75 / 207.95 | Same totals within each licensed date band |
| eBilanz+ web, pay-as-you-go | 35.00 / 41.65 | 105.00 / 124.95 | 175.00 / 208.25 | Same totals when originals filed there |
| eBilanz+ web, one prepaid five-pack | 160.00 / 190.40 | 160.00 / 190.40 | 160.00 / 190.40 | Same totals; 4 / 2 / 0 original-filing credits left |
| eBilanz-Online web | 39.00 / 46.41 | 117.00 / 139.23 | 195.00 / 232.05 | Budget 78.00 / 92.82; 234.00 / 278.46; 390.00 / 464.10 |
| Direct ERiC, software fees only | 0 / 0 | 0 / 0 | 0 / 0 | Same fee totals; correction workflow still engineering work |

eBilanz+'s standard five-pack is EUR 160 net and does not expire under the current offer. Paying EUR 160 today to save EUR 15 over five filings assumes five actual uses and continued provider availability. For a single 2026 return, start with one filing. [Package pricing](https://ebilanzplus.de/kosten)

### API and other optional costs

eBilanz+ basic REST case/client management is free after activation. Validation/transmission requires **PRO 299 + API addon 499 = EUR 798 net / 949.62 gross per year**, plus prepaid credits. The smallest PRO pack is five credits for **EUR 144 net / 171.36 gross**. Every API transmission, including corrections and opening balances, consumes credit. Individual technical assistance is by agreement. No separate fixed setup fee is published in that tariff. [Price and service description, 19 February 2026, pp. 1–2](https://ebilanzplus.de/rechtliches/terms)

| eBilanz+ API, credits bought only when needed | 1 year | 3 years | 5 years |
| --- | ---: | ---: | ---: |
| One original/year | 942.00 / 1,120.98 | 2,538.00 / 3,020.22 | 4,134.00 / 4,919.46 |
| One original + one correction/year | 942.00 / 1,120.98 | 2,682.00 / 3,191.58 | 4,278.00 / 5,090.82 |

Calculation: `798 × years + 144 × ceil(transmissions / 5)`, with annual subscription payments and credit-pack VAT rounded separately. The first API row leaves 4 / 2 / 0 credits; the second leaves 3 / 4 / 0. This is cash outlay, not a prorated EUR 28.80 cost for buying an unavailable single API credit. The API route is unnecessary for the recommended manual handoff. [Developer offer](https://ebilanzplus.de/fuer-entwicklerinnen)

No public priced filing API was verified for myebilanz or eBilanz-Online in the reviewed material; **unknown is not free**. eBilanz-Online describes an in-house installation available by inquiry, without a price on that page; it is excluded from the web-price comparison. [In-house option](https://www.ebilanzonline.de/wissen/faq/sicherheit-und-hosting/)

## Receiver contracts and privacy

| Route | Verified input path / important boundary | Data handling and effort |
| --- | --- | --- |
| myebilanz BASIS | CSV balances plus INI master data and mapping; manual entry also supported | Windows desktop; preparation and ERiC checking can be offline, eventual transmission goes directly to the tax authority. More text-configuration work |
| myebilanz PLUS | Same CSV route; automatic mapping from a CSV XBRL column and XBRL import are paid features. XBRL import covers **only Bilanz and GuV** | Same local architecture; GUI mapping reduces owner work, but other sections still need completeness checks |
| eBilanz+ web | CSV SuSa and account mapping; supported sections include tax reconciliation, assets and detailed balances. Do not promise arbitrary XBRL ZIP upload | Browser/cloud processing; owner uploads balances. Its privacy policy lists infrastructure providers and international-transfer mechanisms; do not describe it as local-only |
| eBilanz-Online web | XBRL import and editing explicitly documented; Excel mapping/account imports. CSV/TXT SAP structure imports have their own hierarchy rules | Provider says data is stored in its Cologne data centre, with transmissions/protocols retained and user deletion available. Browser handoff and mapping checks required |
| Direct ERiC | Correct ELSTER envelope containing qualified application-generated XBRL; not the ZIP file | App/operator controls local files and logs; eventual direct authority transmission. Highest engineering/maintenance effort |

Sources: [myebilanz functions](https://www.myebilanz.de/050-funktionen.php), [local architecture](https://www.myebilanz.de/000-was-ist-myebilanz.php), [eBilanz+ functions](https://ebilanzplus.de/funktionen), [service scope](https://ebilanzplus.de/rechtliches/terms), [privacy](https://ebilanzplus.de/datenschutz), [eBilanz-Online XBRL import](https://www.ebilanzonline.de/wissen/faq/importmoeglichkeiten/xbrl-datei/), [mapping](https://www.ebilanzonline.de/wissen/faq/mapping-und-datenerfassung/), [hosting](https://www.ebilanzonline.de/wissen/faq/sicherheit-und-hosting/).

### Exact myebilanz constraints for #37

The current [manual](https://www.myebilanz.de/myebilanz.pdf), version 2.3.1.x, sections 3.2.2, 15.5–15.6 (PDF pp. 19, 182–188), specifies:

- CSV columns: account, balance, description; debit positive, credit negative; point or comma decimal, no thousands separators. One row per account; account `0` is reserved; KS needs nonblank descriptions.
- CSV accepts UTF encodings; INI requires ANSI/Windows-1252. These are separate contracts.
- Quoted fields can contain delimiters, but embedded double-quote escaping is unsupported. Do not silently corrupt names.
- Tax-reconciliation corrections cannot be included in CSV. Configure them separately.
- `[csv]` uses `filename`, `delimiter`, `fieldKto`, `fieldValue`, `fieldName`; unused field indexes are `0`. `fieldXBRL` automatic mapping requires PLUS.

Downloaded manual SHA-256: `a73e2fdc36e55b541d833b9cac9e2e95b4d2e4b5935f38298bebe4a0be5bf0f2`. Keep a portable UTF-8 SuSa separately from the receiver-specific files. #37 must verify decoding, signs, quotes, zero balances and all required non-CSV sections with synthetic fixtures; reject unrepresentable input or disclose an explicit conversion. No receiver import was executed here.

## 2026 taxonomy choice

Use **6.9 as the initial 2026 target**, with exact period applicability and installed receiver support checked by #36. The BMF's 10 June 2025 letter applies it to fiscal years starting after 31 December 2025 and announced live availability from May 2026. The 8 June 2026 letter permits 6.10 early for 2026, but announced test availability only from November 2026 and live availability from May 2027. Those are announced dates, not evidence of an installed plugin or a successful run. On this research date, do not select 6.10 merely because it is newer. [BMF 6.9](https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Einkommensteuer/2025-06-10-ebilanz-taxonomien-6-9.pdf?__blob=publicationFile&v=7), [BMF 6.10](https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Einkommensteuer/2026-06-08-ebilanz-taxonomien-6-10.pdf?__blob=publicationFile&v=4)

## Unternehmensregister remains a separate budget

None of the E-Bilanz totals includes publication/deposit. eBilanz+ lists a separate EUR 19 net / 22.61 gross disclosure service; its XML export is free after E-Bilanz transmission, otherwise EUR 5 net / 5.95 gross. eBilanz-Online lists a separate EUR 39 net / 46.41 gross Offenlegung/DiFin period. myebilanz PLUS includes disclosure XML generation. These are software/service prices, not evidence that statutory register charges are included. [eBilanz+ tariff](https://ebilanzplus.de/rechtliches/terms), [eBilanz-Online tariff](https://www.ebilanzonline.de/preismodell/), [PLUS functions](https://www.myebilanz.de/075-plus-funktionen.php)

For 2026 accounts, use the **Unternehmensregister** tariff, not old Bundesanzeiger deposit prices. Its current [official tariff](https://www.publikations-plattform.de/order/D051Preisliste.pdf) refers disclosure/deposit and identification fees to the JVKostG schedule and lists additional conversion charges: Word/RTF/Excel/PDF at 1.75 cents per visible character and graphics at EUR 20, plus VAT; scans have a different rate. Thus a readable PDF from the app is not necessarily the cheapest filing input. [#38](https://github.com/SanjoSolutions/accounting/issues/38) owns the minimized manual package and exact register-fee/format choice; [#32](https://github.com/SanjoSolutions/accounting/issues/32) owns direct webservice qualification. Do not add an old EUR 23 estimate or apply VAT indiscriminately to statutory fees.

## Break-even and implementation order

These are planning assumptions, not provider estimates: value owner/developer time at **EUR 50/hour net** and assume existing hardware. PLUS or eBilanz+ costs about **42 minutes** of time per year. If either saves more than that compared with BASIS, it is cheaper in total time-plus-cash cost. eBilanz-Online's EUR 4 premium over eBilanz+ buys only **4.8 minutes** at this rate; a verified XBRL import that avoids remapping can justify it.

Direct ERiC saves at most EUR 35/year against eBilanz+ web, or EUR 0 against BASIS. At EUR 50/hour, five years of EUR 175 fees fund only **3.5 development hours**, before maintenance. With an illustrative 40-hour build (EUR 2,000), no maintenance and no extra hardware, break-even against EUR 35 filings is **58 filings**. With two maintenance hours/year, annual maintenance alone is EUR 100: one UG never breaks even on filing-fee savings. Automation could still be valuable across more companies or products, but that is a separate business case.

Developer planning ranges after the authoritative dataset is available: roughly 1–3 days for a verified CSV/INI adapter and fixtures, 0.5–2 days for a provider handoff/checklist, and at least 5–15 days for a direct bridge/output-qualification spike plus release maintenance. These exclude the accounting/taxonomy corrections in #36, external approval lead time and unknown license obligations; re-estimate after developer access.

1. **#36:** one immutable 2026 close dataset, complete facts, correct tax treatment, pinned taxonomy and reconciled XBRL.
2. **#37:** BASIS adapter and portable SuSa, retained bytes and manifest, honest export/validation/submission states. Verify in the receiver without transmission before labeling it compatible. Use PLUS/eBilanz+ if configuration effort outweighs its small fee; use eBilanz-Online if the complete XBRL import is the better fit.
3. **#38:** readable annual accounts and separate minimized register handoff.
4. **#31 / #21:** pursue direct ERiC only if its independent automation/privacy value justifies the engineering; follow the [qualification plan](./eric-direct-qualification-plan.md). Exporting for another app does not require our own manufacturer ID or bridge setup.

This decision does not close [#21](https://github.com/SanjoSolutions/accounting/issues/21), [#30](https://github.com/SanjoSolutions/accounting/issues/30), [#31](https://github.com/SanjoSolutions/accounting/issues/31) or [#32](https://github.com/SanjoSolutions/accounting/issues/32). Their external acceptance evidence is still outstanding. It does not reopen #33 or introduce a mandatory professional-signoff blocker.
