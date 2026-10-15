# Tax preparation for review without transmission

Issue: [#29](https://github.com/SanjoSolutions/accounting/issues/29).

## Supported workflow

In **Tax filings**, select the form and period and choose **Prepare for review**
(German: **Zur Prüfung vorbereiten**). This derives the dataset using the existing
tenant-scoped preparation services, shows a review panel and, for UStVA, retains
the existing copy view. No tax gateway is required or called by this action.

Local preparation supports the installed 2025/2026 UStVA and annual VAT datasets,
and the existing narrow KSt/GewSt workflow for eligible German UG/GmbH cases.
Existing source checks still apply: effective company profile, reconciled VAT,
and, for the narrow annual workflow, the current locked HGB close, supported facts
and evidenced adjustments. The new action does not broaden tax coverage. Other
annual forms can require the existing external calculation authority and are
explicitly excluded from this local-only action.

**Download review file** saves a JSON snapshot containing the selected form,
period, taxpayer identity, form version, original fields, source references,
preparation time and available company context / non-binding annual preview.
Monetary source values are integer EUR cents; `HEBESATZ_BP` uses basis points.
The screen displays known monetary values as EUR, rates as percentages and leaves
identifiers intact. Internal annual calculation fields are not a complete set of
ELSTER form fields. They require manual mapping and completion.

The file explicitly identifies itself as `LOCAL_REVIEW_ONLY`. It is not an ELSTER
import file, an official validation result, a saved Mein ELSTER draft, a complete
tax return or proof of filing. It contains sensitive company information and is
downloaded only to the user's browser. The ELSTER link is a fixed public forms
URL with no company data in its parameters.

Review the values and supporting records, open the matching form/year in Mein
ELSTER, transfer and complete the values manually, and save that form as a draft.
Do not submit during this review. The application neither logs into the portal
nor controls it. Downloaded snapshots do not update when accounting records change;
prepare again after changes. Selecting a different form or period clears the
displayed snapshot, and starting a fresh preparation clears it before loading.

The existing **Validate officially** / **Submit binding** flow remains separate.
Local preparation does not enable the approval checkbox or submission button.
Those require successful official validation and a separate explicit approval;
server-side source checks and transmission safeguards remain in force. A failed
validation does not enable submission. Preparation records remain local; no
filing workflow record, submission reservation or receipt is created by the new
action.

## Official interfaces checked on 15 October 2026

- [ELSTER developer information](https://www.elster.de/elsterweb/infoseite/entwickler)
  documents ERiC as a library for checking tax data and transmitting it to the
  tax administration. It describes developer registration and access to the
  developer area. This is not documentation for creating account drafts in
  Mein ELSTER.
- [The official UStVA form entry](https://www.elster.de/eportal/formulare-leistungen/alleformulare/ustvaeru)
  explicitly offers XML upload from third-party software after year selection.
  This confirms a manual import possibility for this form, not a general
  remote draft-creation API or compatibility with this application's internal
  dataset JSON / E-Bilanz XML.
- The official links for
  [interface descriptions](https://www.elster.de/elsterweb/entwickler/infoseite/schnittstellenbeschreibungen)
  and [ERiC documentation](https://www.elster.de/elsterweb/entwickler/infoseite/eric)
  redirected to the developer login during this investigation.

No public documented interface for automatically creating arbitrary Mein ELSTER
account drafts was found. This is a limit of the verified documentation, not a
claim that such an interface can never exist. Consequently this implementation
uses the manual handoff above and makes no claim of official import qualification.
An XML export would require the current official schema for each supported form
and year and genuine validation/import evidence before advertising compatibility.
The next step for that extension is to obtain the relevant specification through
authorized ELSTER developer access and qualify a form-specific exporter. No
registration, provider enrollment, portal mutation or tax transmission was
performed for this issue.

## Verification

- `src/taxReview.spec.ts` covers local route selection, unsupported forms/years,
  failed and mismatched preparation, exact download contents and provenance,
  unit handling and the public ELSTER link.
- `playwright.elster-review.config.ts` runs one browser worker on port **3229**,
  using **elster-review-playwright.db** and
  **.playwright/elster-review-documents**. Both tax gateway and annual calculator
  are unconfigured. The browser test prepares and downloads UStVA and annual VAT
  with synthetic company data, verifies that no workflow POST or persisted filing
  is created, and checks that local preparation cannot authorize submission.
- Desktop and mobile screenshots are produced for the required Codex 5.6-Sol
  visual review; layout is not asserted in unit or browser tests.

Run the focused browser check with
`pnpm exec playwright test --config playwright.elster-review.config.ts` after
confirming port 3229 is unused. The runner refuses to reuse another server.
Never use port 3000, `accounting.db` or the live document store for verification.
