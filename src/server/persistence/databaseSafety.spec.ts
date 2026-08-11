import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  assertDisposableDatabasePath,
  assertTestDatabaseSafe,
  createVerifiedBackup,
  databaseUrlForPath,
  isProtectedDatabasePath,
  resolveApplicationDatabaseUrl,
} from '../../../tools/db-safety.mjs'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('database safety boundaries', () => {
  test('rejects the company database and sidecars as disposable E2E targets', () => {
    expect(() => assertDisposableDatabasePath('accounting.db')).toThrow(/protected database path/)
    expect(() => assertDisposableDatabasePath('accounting.db-wal')).toThrow(/protected database path/)
    expect(() => assertDisposableDatabasePath('ACCOUNTING.DB')).toThrow(/protected database path/)
    expect(isProtectedDatabasePath(path.resolve('accounting.db'))).toBe(true)
  })

  test('requires explicit database URLs in disposable application modes', () => {
    expect(() => resolveApplicationDatabaseUrl({ env: { NODE_ENV: 'test' } })).toThrow(/DATABASE_URL must be explicitly set/)
    expect(() => resolveApplicationDatabaseUrl({ env: { NODE_ENV: 'test', DATABASE_URL: 'file:./accounting.db' } })).toThrow(/protected company database/)
    expect(() => assertTestDatabaseSafe({ env: { NODE_ENV: 'test', DATABASE_URL: 'file:./accounting.db' } })).toThrow(/protected company database/)
  })

  test('creates an integrity-checked, hashed backup outside disposable paths and bounds retention', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'accounting-db-safety-'))
    temporaryDirectories.push(directory)
    const databasePath = path.join(directory, 'accounting.db')
    const backupDirectory = path.join(directory, 'backups')
    const database = new DatabaseSync(databasePath)
    database.exec('CREATE TABLE example (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO example(value) VALUES (\'safe\')')
    database.close()

    const result = await createVerifiedBackup({ databasePath, cwd: directory, env: { NODE_ENV: 'test', COMPANY_BACKUP_DIR: backupDirectory, COMPANY_BACKUP_RETENTION: '1' } })
    expect(result.verified).toBe(true)
    expect(result.backupPath).toBeDefined()
    expect(await stat(result.backupPath!)).toBeTruthy()
    expect(JSON.parse(await readFile(result.manifestPath!, 'utf8'))).toMatchObject({ sqliteIntegrity: 'ok', databaseHash: result.databaseHash })

    const second = await createVerifiedBackup({ databasePath, cwd: directory, env: { NODE_ENV: 'test', COMPANY_BACKUP_DIR: backupDirectory, COMPANY_BACKUP_RETENTION: '1' } })
    expect(second.verified).toBe(true)
    const backupNames = (await import('node:fs/promises')).readdir(backupDirectory)
    expect((await backupNames).filter(name => name.endsWith('.db'))).toHaveLength(1)
  })

  test('reports an explicit first-start baseline when the company database does not exist', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'accounting-db-safety-'))
    temporaryDirectories.push(directory)
    const result = await createVerifiedBackup({ databasePath: path.join(directory, 'accounting.db'), cwd: directory, env: { NODE_ENV: 'test', COMPANY_BACKUP_DIR: path.join(directory, 'backups') } })
    expect(result).toMatchObject({ verified: false, skipped: true })
  })

  test('derives an explicit disposable URL without falling back to the company file', () => {
    const url = databaseUrlForPath(path.resolve('playwright.db'))
    expect(url).toBe('file:./playwright.db')
  })

  test('keeps the one-command solo workflow, external backups, E2E env pairing, and operator guidance wired together', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }
    const companyStart = readFileSync('tools/company-start.mjs', 'utf8')
    const guardedPrisma = readFileSync('tools/guarded-prisma.mjs', 'utf8')
    const e2eLauncher = readFileSync('tools/e2e-dev.mjs', 'utf8')
    const setup = readFileSync('SETUP.md', 'utf8')
    expect(packageJson.scripts.solo).toBe('node tools/company-start.mjs')
    expect(companyStart).toContain('guarded-prisma.mjs')
    expect(companyStart).toContain('resolveBackupDirectory')
    for (const launcher of [companyStart, guardedPrisma, e2eLauncher]) {
      expect(launcher).not.toContain('prisma.cmd')
      expect(launcher).toContain('node_modules/prisma/build/index.js')
    }
    expect(e2eLauncher).not.toContain('next.cmd')
    expect(e2eLauncher).toContain('node_modules/next/dist/bin/next')
    expect(e2eLauncher).toContain('E2E_DATABASE_FILE')
    expect(e2eLauncher).toContain('DATABASE_URL')
    expect(setup).toContain('pnpm run solo')
    expect(setup).toContain('ALLOW_PROTECTED_DATABASE=true')
    expect(setup).toContain('restore safely')
  })

  test('blocks guarded Prisma migrations against the company database without explicit opt-in', () => {
    const result = spawnSync(process.execPath, ['tools/guarded-prisma.mjs', 'migrate', 'deploy'], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: 'development', VITEST: 'false', DATABASE_URL: 'file:./accounting.db', ALLOW_PROTECTED_DATABASE: 'false' },
      encoding: 'utf8',
    })
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toContain('Refusing Prisma migration against the protected company database')
  })

  test('fails E2E preparation before any deletion when its disposable target is missing or protected', () => {
    const missing = spawnSync(process.execPath, ['e2e/prepare-database.mjs'], { cwd: process.cwd(), encoding: 'utf8' })
    expect(missing.status).not.toBe(0)
    expect(`${missing.stdout}\n${missing.stderr}`).toContain('E2E_DATABASE_FILE must be explicitly set')

    const protectedTarget = spawnSync(process.execPath, ['e2e/prepare-database.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, E2E_DATABASE_FILE: 'accounting.db', DATABASE_URL: 'file:./accounting.db' },
      encoding: 'utf8',
    })
    expect(protectedTarget.status).not.toBe(0)
    expect(`${protectedTarget.stdout}\n${protectedTarget.stderr}`).toContain('protected database path')
  })
})
