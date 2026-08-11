import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { assertTestDatabaseSafe, databaseUrlForPath } from '../../tools/db-safety.mjs'

// A Vitest worker gets a private disposable URL when no test URL was supplied.
// This keeps unit imports useful while making the company database impossible to
// reach through a Prisma fallback. Persistence suites may override this before a
// dynamic Prisma import, as they already do for their temporary databases.
if (!process.env.DATABASE_URL?.trim()) {
  const worker = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? 'main'
  process.env.DATABASE_URL = databaseUrlForPath(resolve(tmpdir(), `accounting-vitest-${process.pid}-${worker}-${randomUUID().slice(0, 8)}.db`))
}
assertTestDatabaseSafe()
