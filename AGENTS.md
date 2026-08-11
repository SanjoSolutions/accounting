Use best practices of professional software development.
Make sure to refactor the software to keep it more maintainable.
Never push (Git) unless explicitly asked for.

## Testing

Every requirement requires at least one automated test.
Test efficiently (prefer faster unit tests over slower bigger scope test when sufficient).
UI layout should not be tested with unit/E2E tests. Instead UI should be reviewed by Codex (5.6-Sol) regarding if it meets best practices (see Web design section).

## Unit Testing

Use Vitest. Use behavior driven development (BDD) style test descriptions. Use `test` (not `it`).

### E2E Testing

Use Playwright. Use page models. Mostly focus on happy paths. Only add E2E tests for error paths if it is critical for UX and cannot be sufficiently tested with unit tests.

## Verification

For test coverage you can run `pnpm run coverage`.
Run all unit tests.
Run E2E tests only selectively.

### Local testing safety boundary (HIGH VISIBILITY)

`http://localhost:3000` is the live app instance connected to the real business/company database. Never use that instance for automated tests, UI verification, exploratory browser testing, test uploads, mutations, or test data. Merely making client-only changes in the live UI is also prohibited as testing.

Agents must start and use their own isolated app instance on a different port. Prefer the existing test/E2E ports such as `3100`, `3110`, or `3120`, or choose another unused non-`3000` port. Set an explicit disposable test `DATABASE_URL` and isolated document storage for that instance; a disposable DB must never share the live database or document storage. Before any browser action, verify the target URL and port and confirm database and document-storage isolation.

Never run destructive reset, migration, or test tooling against `accounting.db` (including its SQLite sidecars).

## Web design

Use Bootstrap 5. Use Bootstrap patterns preferably. If Bootstrap has no pattern for what you require, you can introduce new UI components/elements/variants. Make sure to implement new UI components in a reusable way.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
