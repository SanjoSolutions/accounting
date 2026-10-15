# Automated HGB close: supported scope and legal rule profile

Base rule profile checked against the official consolidated statutes on 2026-08-03; owner review and UG result appropriation checked on 2026-10-13. This document defines product boundaries; it is not a legal-compliance certificate. The close must fail closed when an applicability fact, source record, review, or approval is missing. The additional check does not extend the base profile's supported fiscal-period start dates.

## Initial supported scope

Rule set `HGB-DE-2024.1` supports a standalone German GmbH or UG (haftungsbeschränkt) that is MICRO or SMALL, unlisted, not a public-interest entity, not in a regulated/special accounting sector, uses a going-concern basis, has no group-account exemption or consolidation requirement, and has a twelve-month fiscal year beginning from 2024-01-01 through the legal validation date 2026-08-03. Liquidation, insolvency, formation, conversion, and form-change periods are unsupported in this first profile.

AG/KGaA, partnerships including § 264a entities, sole traders, cooperatives, medium/large entities, capital-market entities, groups, foreign entities, short years, pre-2024 rule profiles, and sector-specific entities are explicitly unsupported in this version. An unsupported or unknown fact is a blocker, never a default or zero value.

## Versioned applicability

The current thresholds apply to fiscal years beginning after 2023-12-31, with the coordinated optional early-adoption rule in EGHGB Art. 93. The engine therefore selects rules by fiscal-period start.

| Class | Balance-sheet total | Revenue | Quarterly-average employees | Rule |
| --- | ---: | ---: | ---: | --- |
| MICRO | EUR 450,000 | EUR 900,000 | 10 | At least two of three, subject to § 267a exclusions |
| SMALL | EUR 7,500,000 | EUR 15,000,000 | 50 | At least two of three |

The size effect normally requires two consecutive closing dates. Formation/conversion cases use their statutory transition rule. Missing prior observations or the established prior classification blocks relief.

Sources: [HGB § 267](https://www.gesetze-im-internet.de/hgb/__267.html), [HGB § 267a](https://www.gesetze-im-internet.de/hgb/__267a.html), [EGHGB Art. 93](https://www.gesetze-im-internet.de/hgbeg/art_93.html).

## Mandatory workpaper gates

Every applicable workpaper needs retained evidence, a named preparer, and a dated review. Independent review by a different person remains the default product control. It is not a generic statutory audit requirement for these small entities ([HGB § 316(1)](https://www.gesetze-im-internet.de/hgb/__316.html)). Bare confirmation booleans do not satisfy the gate.

An authenticated tenant owner can explicitly select a versioned `OWNER_SELF_REVIEW` policy for an eligible German MICRO/SMALL UG. The owner must retain evidence and a reason, attest that they are the sole shareholder and sole managing director, and confirm that legislation, articles and agreements do not impose an additional independent review. This product mode is not offered for GmbH, larger entities, other legal forms or unsupported applicability facts. A delegated administrator cannot select it or impersonate the owner. Other people may still perform genuine independent reviews.

Self-review stores the actual preparer/reviewer identity, review timestamp, reason, policy version, workpaper checksum and evidence fingerprint. It is visibly described as self-review and never as independent approval or a statutory audit opinion. Policy/evidence/profile/size changes invalidate the applicable approvals. New workpaper versions and a fresh annual package are required; historical reviews are retained. Existing independent reviews remain usable under the default policy. Historical annual packages without a source binding must be regenerated for owner self-review. Existing close snapshots can require reevaluation after the expanded comparative-source fingerprint.

Self-review does not replace the dated signature of the managing director ([HGB § 245](https://www.gesetze-im-internet.de/hgb/__245.html)), shareholder adoption and result appropriation ([GmbHG § 42a](https://www.gesetze-im-internet.de/gmbhg/__42a.html)), or any applicable external review. The self-review signature roster must contain the actual owner. Closing still requires an approved immutable annual package, retained signature and resolution evidence, all applicable workpapers, reconciled statements, and posted adjustments.

- Opening balance and continuity with the prior finalized close.
- Complete one-to-one account mapping, balance-sheet/P&L presentation, comparatives, and reconciliation.
- Recognition, economic ownership, non-offsetting, and prohibited/optional items.
- Cut-off, prepaid expenses, deferred income, and period allocation.
- Provisions, contingent liabilities, contracts, estimates, maturity and discounting.
- Receivable collectibility, lower-value tests, market values, impairment and reversals.
- Fixed assets, useful lives, depreciation, impairment, disposal and GL reconciliation when applicable.
- Inventory population/count, permitted count method, cost formula, lower-value test and GL reconciliation when applicable.
- Subsequent events, going concern, and policy-election consistency.
- Notes questionnaire or a separately evidenced workpaper proving every condition for the micro notes omission, including the required below-balance-sheet disclosures.
- GmbH/UG equity, shareholder balances and result appropriation; the UG statutory reserve when GmbHG § 5a continues to apply.

Core sources: [HGB §§ 238-239](https://www.gesetze-im-internet.de/hgb/__238.html), [§§ 240-241](https://www.gesetze-im-internet.de/hgb/__240.html), [§§ 242-245](https://www.gesetze-im-internet.de/hgb/__242.html), [§§ 246-251](https://www.gesetze-im-internet.de/hgb/__246.html), [§§ 252-256a](https://www.gesetze-im-internet.de/hgb/__252.html), [§§ 264-275](https://www.gesetze-im-internet.de/hgb/__264.html), [§§ 284-285 and 288](https://www.gesetze-im-internet.de/hgb/__284.html), [GmbHG §§ 29, 42, 42a](https://www.gesetze-im-internet.de/gmbhg/__42a.html), and [GmbHG § 5a(3)](https://www.gesetze-im-internet.de/gmbhg/__5a.html).

## Output and lifecycle

Small and micro entities in this initial scope do not require a management report under HGB § 264(1) sentence 4 and are outside the statutory audit requirement in HGB § 316(1). A normal small entity still needs notes. A micro entity may omit notes only when every condition in § 264(1) sentence 5 and the additional true-and-fair disclosure assessment is satisfied and the required facts are shown below the balance sheet.

The software may label an artifact prepared or approved only according to its recorded lifecycle. `READY_TO_LOCK` means that all recorded representatives have supplied dated signature evidence and the shareholder establishment/result-appropriation resolution is retained; it is not a legal-compliance certification. Disclosure/transmission is a separate workflow governed by [HGB §§ 325-326](https://www.gesetze-im-internet.de/hgb/__325.html). Retention follows [HGB § 257](https://www.gesetze-im-internet.de/hgb/__257.html).

## Implemented product boundary

The implementation now provides versioned applicability and size classification, a dedicated evidence-qualified browser form for historical fiscal-year profile and mapping onboarding, evidence-backed typed workpapers for every gate above, explicit independent/owner review policies, deterministic adjustment posting, acquisition/production-cost and subsequent asset valuation, FIFO/weighted-average inventory valuation (LIFO is rejected in this profile), lower-value tests, GL reconciliation controls, one-to-one effective-dated HGB mappings with explicit presentation signs, MICRO/SMALL hierarchy rollups, prior-presentation reconciliation, immutable annual-account packages selected visibly by version, signature/resolution evidence, and a ledger lock bound to the current ledger/profile/mapping/workpaper/evidence/review-policy/comparative-source fingerprint.

Historical company profiles and mapping cohorts require retained evidence and exact fiscal-period coverage. Missing, overlapping, malformed, unsupported, unreviewed, unposted, or stale inputs block generation or locking. The implementation does not silently infer a legal form, size class, accounting policy, inventory/asset applicability, note disclosure, representative roster, or mapping.

This rule profile does not automate tax-balance reconciliation, e-balance filing, Unternehmensregister transmission, legal advice, statutory audit work, consolidation, sector forms, or facts outside the initial scope. `READY_TO_LOCK` records that the configured controls for the supported profile passed; it is not a legal-compliance certificate and does not replace management, tax-adviser, auditor, or legal review where applicable.

## UG statutory reserve and result appropriation

Where GmbHG § 5a remains applicable, the workpaper explicitly identifies share capital, prior profit or loss carryforward, prior statutory reserve, current annual result, reserve allocation and remaining carryforward. The required allocation is one quarter of the positive annual result after deducting prior loss carryforward. Prior profit is not part of that reserve base; loss or zero-result years create no allocation. The product rounds a fractional cent upward to avoid under-allocation; this is an explicit product convention, not a rounding rule stated in the statute. Applicability is documented separately, including any capital increase under [GmbHG § 5a(5)](https://www.gesetze-im-internet.de/gmbhg/__5a.html).

The supported workflow carries the remaining result forward. Distributions and reserve releases are unsupported and blocked; it does not automate the capital-maintenance assessment for distributions. A positive reserve allocation requires a reviewed, evidenced adjustment debiting the carryforward account and crediting a separate statutory reserve account. The annual package reconciles the declared prior carryforward, capital and reserve against both years' ledger balances and the posted adjustment. Missing evidence or a one-cent difference blocks preparation.

The SMALL balance sheet presents the remaining Bilanzgewinn/Bilanzverlust after partial appropriation with the included prior carryforward explained, in accordance with [HGB § 268(1)](https://www.gesetze-im-internet.de/hgb/__268.html). MICRO retains aggregate equity. The income statement continues to show the full annual result; the package retains the appropriation amounts and evidence references.

See [the isolated synthetic acceptance fixture](ug-2026-close-fixture.md) for reproducible verification and its limits.
