Use best practices of professional software development.
Make sure to refactor the software to keep it more maintainable.
Never push (Git) unless explicitly asked for.

## Testing

Every requirement requires at least one automated test.
Test efficiently (prefer faster unit tests over slower bigger scope test when sufficient).

## Unit Testing

Use Vitest. Use behavior driven development (BDD) style test descriptions.

### E2E Testing

Use Playwright. Use page models. Mostly focus on happy paths. Only add E2E tests for error paths if it is critical for UX and cannot be sufficiently tested with unit tests.

## Verification

For test coverage you can run `pnpm run coverage`.
Run all unit tests.
Run E2E tests only selectively.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
