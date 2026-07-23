Use best practices of professional software development.
Make sure to refactor the software to keep it more maintainable.
Never push (Git) unless explicitly asked for.

## Testing

Every requirement requires at least one automated test.
Test efficiently (prefer faster unit tests over slower bigger scope test when sufficient).
Use behavior driven development (BDD) style test descriptions.

## Unit Testing

Use Vitest.

### E2E Testing

Use Playwright. Use page models. Mostly focus on happy paths. Only add E2E tests for error paths if it is critical for UX and cannot be sufficiently tested with unit tests.

## Verification

For test coverage you can run `pnpm run coverage`.
