# Jahresabschluss and manual Unternehmensregister handoff

Implemented for the existing supported MICRO/SMALL UG/GmbH close. This is a document export, not an Unternehmensregister client or tax submission.

## Owner workflow

1. Prepare the annual accounts from reviewed workpapers, approve the package, and evaluate a current ready HGB close with recorded signatures and shareholder-resolution evidence.
2. In **Compliance → Jahresabschluss herunterladen**, select the precise fiscal-period/package version. Export the full annual accounts. Open the print view or download the ZIP containing the HTML, machine-readable snapshot, and SHA-256 manifest.
3. For the register, open **Manuelles Paket für das Unternehmensregister**. Select the approved disclosure text that belongs in the public document. MICRO uses the evidenced notes exemption and required below-balance-sheet disclosures; SMALL uses the balance sheet and required notes, excluding exclusively GuV-related disclosures. Enter the actual establishment date from the resolution. Confirm completeness and minimization.
4. Download the separate manual ZIP. Its `einreichung.html` contains the selected filing document; `ANLEITUNG.txt` gives the portal steps. Print only that HTML to a searchable PDF (A4, 100%, browser headers/footers off), and review every PDF page before personally uploading it. Keep `manifest.json` locally. Internal JSON, HTML and ZIP are not asserted to be accepted filing formats.
5. On the Publikations-Plattform, the submitter personally registers/identifies, selects the Unternehmensregister and the appropriate deposit/publication workflow, verifies company/year and previews the converted document, then chooses whether to place the paid order. Keep the submitted PDF, order confirmation and subsequent register evidence together with the export manifest.

No export changes the annual package's approval status or creates any externally filed/accepted state. A manual confirmation is not an authenticated gateway receipt. No enrollment, payment or transmission is performed by this feature.

## Scope and honest gaps

- Source amounts, comparison periods, company identity, policies and notes come from the exact retained approved annual package. The renderer does not query current ledger amounts.
- When the immutable source contains `ugResultAppropriation`, the full report copies its recorded annual result, capital, prior commercial carryforwards, prior reserve, reserve allocation, distribution, remaining carryforward and resolution reference. It preserves the approved partial-appropriation balance labels and never recalculates the allocation. That optional source contract is produced and validated by #35 / PR #55; the renderer adapter can coexist with legacy packages before that producer is integrated.
- The current ready close supplies recorded signature references and the shareholder-resolution reference. For legacy packages, the reviewed equity schedule supplies result, share capital and reserve applicability/evidence. Missing structured allocation amounts and resolution dates remain explicitly unrecorded, not inferred from app approval. The manually confirmed establishment date is separately retained in the manual export manifest.
- Manual balance sheets retain only the supported size-class presentation positions, copying the approved totals exactly. Additional detail in the internal source is omitted. The internal appropriation table and its evidence references never enter the manual document; any required approved disclosure text still needs explicit selection.
- A micro exemption placeholder is not disclosure text. Manual export rejects it. Prepare and approve a corrected annual package containing the actual required statements, including explicit negative statements when evidenced, before exporting.
- Free text cannot be automatically classified as public or private. Nothing is selected by default. The operator must include every required disclosure and omit internal or exclusively GuV-related material. Selected texts are copied verbatim and escaped, with no editing of the approved statement. Unsupported MICRO cases requiring a full Anhang are blocked by this adapter.
- New exports require the exact selected version to match the current ready close, including its existing evidence/fingerprint gates. A later source change blocks new exports. Already retained exports remain downloadable as the exact historical bytes, explicitly labeled as an archive/export state; they are not silently refreshed or represented as currently filing-ready.
- The API does not assert that a stored evidence ID authenticates a handwritten or qualified electronic signature. It displays what the application recorded.

## Verified rules and formats (13 October 2026)

- [HGB § 326](https://www.gesetze-im-internet.de/hgb/__326.html): SMALL transmits balance sheet and notes, which may omit exclusively GuV-related information; eligible MICRO may deposit only the balance sheet and must confirm the size criteria.
- [HGB § 264](https://www.gesetze-im-internet.de/hgb/__264.html): below-balance-sheet disclosures are conditions of the micro notes exemption; company/register identity is required. Additional disclosures may be necessary for a true and fair view.
- [HGB § 328](https://www.gesetze-im-internet.de/hgb/__328.html): complete and correct reproduction within the applicable reliefs, with the establishment/approval date, also for micro deposit.
- [HGB § 325](https://www.gesetze-im-internet.de/hgb/__325.html): regular annual disclosure deadline. Export does not stop the deadline.
- [URV § 11](https://www.gesetze-im-internet.de/urv/__11.html) specifies XML for the supported ordinary cases. The [official publication guide](https://publikations-plattform.de/sp/wexsservlet?page.navid=to_knowledgeable_how-work_annual_publish) also allows PDF/Office with paid operator conversion, and describes a web form for small companies. The app supplies a printable source for this manual PDF path, not official register XML.
- The [official deposit guide](https://publikations-plattform.de/sp/wexsservlet?page.navid=to_knowledgeable_how-work_annual_deposit) explains micro criteria, exclusions, registration and identification. Financial years beginning after 31 December 2021 go to the Unternehmensregister. Check current fees and operator requirements at handoff.

## Implementation and verification

`GET /api/compliance/packages/:id/documents` returns authorized source options and retained export versions. `POST` creates a new retained bundle for `mode: annual|manual`, binding `expectedChecksum` and the explicit disclosure selection. `GET ?artifactId=…&file=…` downloads only whitelisted members of that exact retained ZIP (or `bundle`). Tenant authorization, write role on creation, source and member fixity, private/no-store headers, sandboxed HTML, and audit events are enforced. Metadata and companion JSON remain inside the internal bundle; manual bundles contain only filing HTML, handoff instructions and a local manifest.

The existing retention/backup registry already captures these retained artifacts and object storage references. Creation cleans up its newly written object if registration or the transactional current-close recheck fails.

Run `pnpm test -- --maxWorkers=1 --testTimeout=30000`, `pnpm typecheck`, and `pnpm exec playwright test --config playwright.annual-documents.config.ts`. The latter owns **127.0.0.1:3113**, `annual-documents-playwright.db`, and `.playwright/annual-documents`; it never reuses a running server. It uses synthetic data, actual authentication/workpaper/approval APIs, and the export UI, then saves screenshots and A4 PDFs for visual review. Layout is reviewed visually rather than asserted by unit/E2E geometry tests.
