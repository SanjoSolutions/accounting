import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { assertDisposableDatabasePath, resolveDatabasePath } from '../tools/db-safety.mjs'

const database = assertDisposableDatabasePath('issue-23-playwright.db')
if (resolveDatabasePath(process.env.DATABASE_URL) !== database
  || process.env.E2E_DATABASE_FILE !== 'issue-23-playwright.db'
  || process.env.DOCUMENT_STORAGE_DRIVER !== 'fs'
  || resolve(process.env.DOCUMENT_STORAGE_ROOT ?? '') !== resolve('.playwright/issue-23-documents')
  || resolve(process.env.E2E_DOCUMENT_STORAGE ?? '') !== resolve('.playwright/issue-23-documents')) {
  throw new Error('The booked-document browser fixture requires its dedicated disposable database and document storage.')
}

await run('e2e/prepare-database.mjs')
await run('tools/guarded-prisma.mjs', 'migrate', 'deploy')
await run('tools/local-solo.mjs', 'dev', '--port', '3223')

function run(script, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env: process.env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${script} exited with ${code}`)))
  })
}
