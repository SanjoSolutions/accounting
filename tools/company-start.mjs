import 'dotenv/config'

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { databaseUrlForPath, resolveBackupDirectory, resolveCompanyDatabasePath } from './db-safety.mjs'

const cwd = process.cwd()
const companyDatabasePath = resolveCompanyDatabasePath({ cwd })
const environment = {
  ...process.env,
  DATABASE_URL: databaseUrlForPath(companyDatabasePath, cwd),
  ALLOW_PROTECTED_DATABASE: 'true',
  DB_SAFETY_CONTEXT: 'company-start',
}
const forwardedArguments = process.argv.slice(2)
const prismaBin = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url))

console.log(`[company-start] Database: ${companyDatabasePath}`)
console.log(`[company-start] Backups: ${resolveBackupDirectory({ cwd, env: environment })}`)

await run(process.execPath, ['tools/guarded-prisma.mjs', 'migrate', 'deploy'], environment)
await run(process.execPath, [prismaBin, 'generate'], environment)
await run(process.execPath, ['tools/local-solo.mjs', 'dev', ...forwardedArguments], environment)

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
