import 'dotenv/config'

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { databaseUrlForPath, createVerifiedBackup, isProtectedDatabasePath, resolveApplicationDatabaseUrl, resolveDatabasePath } from './db-safety.mjs'

const args = process.argv.slice(2)
if (args.length === 0) throw new Error('Usage: node tools/guarded-prisma.mjs <migrate dev|migrate deploy|db push> [options]')

const cwd = process.cwd()
const databaseUrl = resolveApplicationDatabaseUrl({ cwd })
const databasePath = resolveDatabasePath(databaseUrl, cwd)
const environment = { ...process.env, DATABASE_URL: databaseUrl }

if (databasePath && isProtectedDatabasePath(databasePath, { cwd, env: environment })) {
  const optedIn = environment.ALLOW_PROTECTED_DATABASE === 'true' || environment.DB_ALLOW_PROTECTED_DATABASE === 'true'
  if (!optedIn) {
    throw new Error(`Refusing Prisma migration against the protected company database: ${databasePath}. Set ALLOW_PROTECTED_DATABASE=true only after reviewing the target; the guard creates a verified backup before running Prisma.`)
  }
  const backup = await createVerifiedBackup({ databasePath, cwd, env: environment })
  if (backup.skipped) {
    console.log(`[db-safety] No pre-migration backup was needed because ${databasePath} does not exist yet.`)
  } else {
    console.log(`[db-safety] Verified pre-migration backup: ${backup.backupPath}`)
  }
}

const prismaBin = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url))
const child = spawn(process.execPath, [prismaBin, ...args], { cwd, env: environment, stdio: 'inherit', shell: false })
child.once('error', error => {
  console.error(error)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exitCode = code ?? 1
})
