import { mkdir, open, rm } from 'node:fs/promises'
import path from 'node:path'

const workspaceRoot = path.resolve('.')
const databasePath = path.resolve('playwright.db')
const documentStoragePath = path.resolve('.playwright', 'documents')

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
