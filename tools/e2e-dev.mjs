import 'dotenv/config'

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertDisposableDatabasePath, databaseUrlForPath } from './db-safety.mjs'

const mode = process.argv[2] ?? 'standard'
const cwd = process.cwd()
const modes = {
  standard: { defaultDatabase: 'playwright.db', port: '3100' },
  'local-solo': { defaultDatabase: 'playwright.db', port: '3110' },
  roles: { defaultDatabase: 'roles-playwright.db', port: '3120' },
  'external-ebilanz': { defaultDatabase: 'external-playwright.db', port: '3112' },
  'annual-documents': { defaultDatabase: 'annual-documents-playwright.db', port: '3113' },
  'document-search': { defaultDatabase: 'document-search-playwright.db', port: '3224' },
}
const selected = modes[mode]
if (!selected) throw new Error(`Unknown E2E mode: ${mode}`)

const requestedDatabase = process.env.E2E_DATABASE_FILE?.trim() || selected.defaultDatabase
const databasePath = assertDisposableDatabasePath(requestedDatabase, { cwd, env: process.env })
const environment = {
  ...process.env,
  E2E_DATABASE_FILE: path.relative(cwd, databasePath).replaceAll(path.sep, '/'),
  DATABASE_URL: databaseUrlForPath(databasePath, cwd),
  DISPOSABLE_DATABASE: 'true',
}
if (mode === 'local-solo') environment.AUTH_MODE = 'none'
const prismaBin = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url))
const nextBin = fileURLToPath(new URL('../node_modules/next/dist/bin/next', import.meta.url))

await run(process.execPath, ['e2e/prepare-database.mjs'], environment)
await run(process.execPath, [prismaBin, 'db', 'push'], environment)
await run(process.execPath, [prismaBin, 'generate'], environment)
if (mode === 'local-solo') {
  await run(process.execPath, ['tools/local-solo.mjs', 'dev', '--port', selected.port], environment)
} else {
  await run(process.execPath, [nextBin, 'dev', '--hostname', '127.0.0.1', '--port', selected.port], environment)
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit', shell: false })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`${command} exited with signal ${signal}`))
      else if (code === 0) resolve()
      else reject(new Error(`${command} exited with code ${code ?? 1}`))
    })
  })
}
