# Reusing booked documents

Issue: https://github.com/SanjoSolutions/accounting/issues/23

The booking document picker starts in **Inbox**, as before. **Already booked**
loads retained documents that have left the inbox. Each document shows its
linked journal entries, dates and posting status. Journal links open the matching
fiscal year and entry in another tab so the current booking is preserved.
Selecting a document explicitly attaches it to the new booking; the draft still
requires the existing review and post-to-journal steps.

The same picker serves new bookings and the add-document flow in booking drafts.
Changing the view preserves selected documents and their preview metadata.
Fresh inbox responses exclude cached evidence that has since been posted.

## API and retention

- `GET /api/documents` and `?view=inbox` retain the existing inbox behavior.
- `GET /api/documents?view=booked` reads `availableForBooking: false` for the
  authenticated tenant, including only journal links owned by that tenant.
- Anonymous requests receive 401. Unsupported view values receive 400.
- History contains journal IDs, references, descriptions, dates, fiscal years,
  posting state and reversal references. Storage keys and owner metadata remain
  private; files and thumbnails use the existing authenticated endpoints.
- Browsing and selection do not rewrite document records or journal links.
  Posting reuses the existing ledger and retention logic. No migration is needed.

## Verification

All verification uses disposable databases and isolated storage. The focused
browser configuration owns `127.0.0.1:3223`, `issue-23-playwright.db` and
`.playwright/issue-23-documents`; it refuses server reuse. Its launcher verifies
these paths before resetting its fixture and applies the real migrations.

```powershell
pnpm exec vitest run src/BookedDocumentList.spec.tsx src/BookingDocuments.spec.ts src/app/api/documents/route.spec.ts src/server/bookedDocuments.persistence.spec.ts --maxWorkers=1
pnpm exec playwright test --config playwright.booked-documents.config.ts
```

The persistence test exercises real retained document storage and ledger posting:
tenant isolation, a second posting with the same document, both attachment links,
unchanged original entries and retention records, and a valid audit chain. UI
tests cover view membership, explicit reselection, preserved preview metadata and
English/German history content. The Playwright journey also covers a receipt
posted while the picker still caches its upload, selection across views, draft
review and posting, and both surviving journal links.

The complete serial unit run passed 1,735 tests across 245 files; 5 tests in 2
files were skipped. The full suite used `--maxWorkers=1 --testTimeout=30000
--hookTimeout=120000` for local Windows verification. No assertion or repository
timeout setting was weakened. Final focused checks follow the subsequent UI
accessibility and presentation refactor.

Final validation passed: 42 tests in 4 focused files, the isolated Playwright
journey, production build and TypeScript check. The final heavy checks held the
shared Windows mutex `Local\CodexAccountingHeavyVerification` and released it in
`finally`. The complete suite predates the final UI changes; the focused tests,
browser journey, build and typecheck were rerun afterward. The build retains four
existing dynamic filesystem-tracing warnings in `tools/db-safety.mjs`.

Codex 5.6-Sol reviewed desktop and 390 px mobile screenshots. The only finding
was missing list semantics, corrected with Bootstrap's `ul` / `li` list-group
pattern. Screenshot artifacts and validation logs are in the ignored
`.playwright` directory of the issue worktree.

No merge or production-data mutation was performed.
