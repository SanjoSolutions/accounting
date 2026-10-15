# Synthetic single-owner UG close for 2026

This fixture is test-only. It is not the user's company, evidence, opening balance, signature or resolution. No external filing, provider, email or payment is involved.

Run `pnpm exec playwright test --config playwright.ug-close.config.ts`. The configuration exclusively uses `http://127.0.0.1:3110`, disposable `ug-close-playwright.db`, and `.playwright/ug-close-documents`. Both the server runner and fixture reject an unexpected database/URL; the test checks document storage before its first browser action. Never run this against port 3000, `accounting.db`, or live document storage. The test's reference date is 2027-02-01.

## Explicit scenario

The fixture creates a synthetic sole shareholder/managing director of a German standalone MICRO UG. It assumes two qualifying size observations, a full calendar year, going concern, no inventory or fixed assets, no employees, no other provisions or contingent liabilities, no management loans, no additional notes-omission issues, and no additional independent-review obligation. These are explicit scenario facts in a retained XML evidence file, not facts inferred about a real business.

The prior period is a synthetic finalized baseline inserted directly for setup. It has €1,000 share capital, €100 prior loss carryforward, €900 bank and no statutory reserve. The 2026 opening matches it. A synthetic €119 no-VAT receipt produces €119 annual profit and €1,019 bank. Income taxes and other obligations are assumed already assessed with no additional current-year expense in this deliberately narrow accounting fixture; the fixture makes no real-world tax assertion.

The reserve is `(€119 - €100) / 4 = €4.75`. The real adjustment posting debits carryforward and credits statutory reserve by €4.75. Remaining result carryforward is €14.25. Final equity is €1,000 capital + €4.75 reserve + €14.25 carryforward = €1,019. No distribution is proposed.

## Verified application path

The test uses one actual authenticated synthetic owner, retained synthetic evidence, profile/mapping onboarding, twelve applicable prepared workpapers, explicit owner-policy selection and self-review, reserve posting, annual-package generation and approval, dated signature/resolution references, evaluation and fiscal-year lock. It checks persisted identities and timestamps, policy binding, immutable appropriation amounts, comparative figures, balanced statements and CLOSED status. It does not create a second person to bypass the default control.

Core and SQLite tests additionally cover missing/foreign evidence, unauthorized policy selection, stale policy/workpaper checksums, locked periods, unsupported legal forms, prior-loss arithmetic, over-allocation, unsupported distributions and ledger differences. Independent review remains the default path. UI screenshots are reviewed separately; layout is not asserted by automated tests.

The same isolated configuration also runs the 2025 UG and 2026 GmbH independent-review regressions with two real synthetic actors. They exercise booking-batch posting, workpaper review, annual approval, signature/resolution evidence and year lock. These regressions stop at the commercial close; external tax and disclosure transmission are outside this issue.

## Immutable report handoff

The reviewed `GMBH_EQUITY_RESULT` schedule stores `resultCents`, `shareCapitalCents` and `resultAppropriation`. Annual-package generation reconciles those values against both ledger years and copies them into `AnnualPackageInput.ugResultAppropriation` inside `immutablePayload`. The annual field names are `annualResultCents`, `shareCapitalCents`, `priorLossCarryforwardCents`, `priorProfitCarryforwardCents`, `priorStatutoryReserveCents`, `reserveAllocationCents`, `distributionCents` and `carryforwardCents`. All monetary values are integer cents. Evidence and account references are retained alongside them.

Report consumers should use the immutable package values without recalculating the allocation. SMALL packages carry the partial-appropriation label in `balanceSheet[].label`; MICRO packages retain aggregate equity. An absent `ugResultAppropriation` means that the historical package lacks this structured contract, not that its amounts are zero. A shareholder establishment date is not supplied by this object and must not be inferred from the app approval or signature timestamp. Human-readable rendering and the manual disclosure selection remain owned by issue #38.
