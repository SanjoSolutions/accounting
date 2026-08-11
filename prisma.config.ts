import 'dotenv/config'
import { defineConfig } from 'prisma/config'
import { isDisposableMode, isProtectedDatabasePath, resolveDatabasePath } from './tools/db-safety.mjs'

const configuredDatabaseUrl = process.env.DATABASE_URL?.trim()
if (isDisposableMode() && !configuredDatabaseUrl) {
  throw new Error('DATABASE_URL must be explicitly set to a disposable database in test or E2E mode; refusing the company database fallback.')
}
const configuredDatabasePath = resolveDatabasePath(configuredDatabaseUrl)
if (isDisposableMode() && configuredDatabasePath && isProtectedDatabasePath(configuredDatabasePath)) {
  throw new Error(`Disposable Prisma commands cannot use the protected company database: ${configuredDatabasePath}`)
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: configuredDatabaseUrl ?? 'file:./accounting.db',
  },
})
