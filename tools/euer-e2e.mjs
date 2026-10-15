import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { assertDisposableDatabasePath, resolveDatabasePath } from './db-safety.mjs'

const cwd = process.cwd()
const databasePath = assertDisposableDatabasePath('euer-playwright.db', { cwd, env: process.env })
if (resolveDatabasePath(process.env.DATABASE_URL, cwd) !== databasePath
  || resolve(process.env.DOCUMENT_STORAGE_ROOT ?? '') !== resolve('.playwright/euer-documents')
  || process.env.E2E_DOCUMENT_STORAGE !== './.playwright/euer-documents'
  || process.env.E2E_DATABASE_FILE !== 'euer-playwright.db') throw new Error('EÜR browser checks require their dedicated disposable database and storage.')
await new Promise((resolve, reject) => {
  const probe = createServer()
  probe.once('error', reject)
  probe.listen(3227, '127.0.0.1', () => probe.close(resolve))
})
await run(['e2e/prepare-database.mjs'])
const database = new DatabaseSync(databasePath)
for (const directory of readdirSync('prisma/migrations', { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort()) database.exec(readFileSync(join('prisma/migrations', directory, 'migration.sql'), 'utf8'))
database.close()
console.log('EÜR isolation verified: 127.0.0.1:3227; euer-playwright.db; .playwright/euer-documents')
await run(['tools/local-solo.mjs', 'dev', '--port', '3227'])

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env: process.env, stdio: 'inherit' })
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal))
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`EÜR test process exited ${code}`)))
  })
}
