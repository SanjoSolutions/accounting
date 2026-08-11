import { mkdir, open, rm } from 'node:fs/promises'
import path from 'node:path'
import { assertDisposableDatabasePath, databaseUrlForPath, resolveDatabasePath } from '../tools/db-safety.mjs'

const workspaceRoot = path.resolve('.')
const requestedDatabase = process.env.E2E_DATABASE_FILE?.trim()
if (!requestedDatabase) throw new Error('E2E_DATABASE_FILE must be explicitly set to a disposable database before preparing E2E state.')
const databasePath = assertDisposableDatabasePath(requestedDatabase, { cwd: workspaceRoot, env: process.env })
const configuredDatabasePath = resolveDatabasePath(process.env.DATABASE_URL, workspaceRoot)
if (configuredDatabasePath && configuredDatabasePath !== databasePath) {
  throw new Error(`E2E_DATABASE_FILE and DATABASE_URL must point to the same disposable database. Got ${databasePath} and ${configuredDatabasePath}.`)
}
process.env.DATABASE_URL = databaseUrlForPath(databasePath, workspaceRoot)
const documentStoragePath = path.resolve(process.env.E2E_DOCUMENT_STORAGE ?? path.join('.playwright', 'documents'))

if (path.dirname(databasePath) !== workspaceRoot) {
  throw new Error('The Playwright database must be inside the workspace root.')
}
if (path.dirname(documentStoragePath) !== path.join(workspaceRoot, '.playwright')) {
  throw new Error('The Playwright document storage must be inside .playwright.')
}

await Promise.all([
  rm(databasePath, { force: true }),
  rm(`${databasePath}-journal`, { force: true }),
  rm(`${databasePath}-shm`, { force: true }),
  rm(`${databasePath}-wal`, { force: true }),
  rm(documentStoragePath, { force: true, recursive: true }),
])
await mkdir(documentStoragePath, { recursive: true })
const database = await open(databasePath, 'a')
await database.close()
