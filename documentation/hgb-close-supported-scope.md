# Automated HGB close: supported scope and legal rule profile

Checked against the official consolidated statutes on 2026-08-03. This document defines product boundaries; it is not a legal-compliance certificate. The close must fail closed when an applicability fact, source record, review, or approval is missing.

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

Every applicable workpaper needs retained evidence, a named preparer, and a dated review by a different person. The two-person review is a conservative product control for auditability, not a statutory audit requirement for these entities. Bare confirmation booleans do not satisfy the gate.

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

The implementation now provides versioned applicability and size classification, evidence-backed typed workpapers for every gate above, independent prepare/review lifecycle, deterministic adjustment posting, acquisition/production-cost and subsequent asset valuation, FIFO/weighted-average inventory valuation (LIFO is rejected in this profile), lower-value tests, GL reconciliation controls, one-to-one effective-dated HGB mappings with explicit presentation signs, MICRO/SMALL hierarchy rollups, prior-presentation reconciliation, immutable annual-account packages, signature/resolution evidence, and a ledger lock bound to the current ledger/profile/mapping/workpaper/evidence fingerprint.

Historical company profiles and mapping cohorts require retained evidence and exact fiscal-period coverage. Missing, overlapping, malformed, unsupported, unreviewed, unposted, or stale inputs block generation or locking. The implementation does not silently infer a legal form, size class, accounting policy, inventory/asset applicability, note disclosure, representative roster, or mapping.

This rule profile does not automate tax-balance reconciliation, e-balance filing, Unternehmensregister transmission, legal advice, statutory audit work, consolidation, sector forms, or facts outside the initial scope. `READY_TO_LOCK` records that the configured controls for the supported profile passed; it is not a legal-compliance certificate and does not replace management, tax-adviser, auditor, or legal review where applicable.
