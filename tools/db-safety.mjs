import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const DEFAULT_COMPANY_DATABASE_FILE = 'accounting.db'
export const DEFAULT_BACKUP_RETENTION = 14
export const MAX_BACKUP_RETENTION = 30

/**
 * A database path is considered disposable only when it is explicitly named by
 * the caller. The application never infers a disposable target from Prisma's
 * default, because that default is the live company database.
 */
export function isDisposableMode(env = process.env) {
  return env.NODE_ENV === 'test'
    || Boolean(env.E2E_DATABASE_FILE?.trim())
    || env.VITEST === 'true'
    || env.PLAYWRIGHT === 'true'
    || env.DISPOSABLE_DATABASE === 'true'
}

export function resolveDatabasePath(databaseUrl, cwd = process.cwd()) {
  if (!databaseUrl?.trim()) return undefined
  const value = databaseUrl.trim()
  if (!/^file:/i.test(value)) return undefined

  const raw = value.slice(5)
  if (!raw) return undefined
  try {
    if (raw.startsWith('//')) {
      const parsed = new URL(value)
      const pathname = decodeURIComponent(parsed.pathname)
      // file:///C:/... is represented with a leading slash on Windows.
      if (/^\/[A-Za-z]:\//.test(pathname)) return path.resolve(pathname.slice(1))
      return path.resolve(pathname)
    }
    const rawPath = raw.split(/[?#]/, 1)[0]
    return path.resolve(cwd, decodeURIComponent(rawPath))
  } catch {
    return undefined
  }
}

export function resolveCompanyDatabasePath({ cwd = process.cwd(), env = process.env } = {}) {
  const configured = env.COMPANY_DATABASE_FILE?.trim() || DEFAULT_COMPANY_DATABASE_FILE
  const fromUrl = resolveDatabasePath(configured, cwd)
  return fromUrl ?? path.resolve(cwd, configured)
}

export function databaseUrlForPath(databasePath, cwd = process.cwd()) {
  const absolute = path.resolve(databasePath)
  const relative = path.relative(cwd, absolute).replaceAll(path.sep, '/')
  if (relative && !relative.startsWith('../') && relative !== '..' && !path.isAbsolute(relative)) {
    return `file:./${relative}`
  }
  return pathToFileURL(absolute).href
}

export function resolveApplicationDatabaseUrl({ cwd = process.cwd(), env = process.env } = {}) {
  const configured = env.DATABASE_URL?.trim()
  if (!configured) {
    if (isDisposableMode(env)) {
      throw new Error('DATABASE_URL must be explicitly set to a disposable database in test or E2E mode; refusing the company database fallback.')
    }
    return databaseUrlForPath(resolveCompanyDatabasePath({ cwd, env }), cwd)
  }

  const configuredPath = resolveDatabasePath(configured, cwd)
  if (isDisposableMode(env) && configuredPath && isProtectedDatabasePath(configuredPath, { cwd, env })) {
    throw new Error(`Disposable mode cannot use the protected company database: ${configuredPath}`)
  }
  return configured
}

export function protectedDatabasePaths({ cwd = process.cwd(), env = process.env } = {}) {
  const paths = new Set([
    path.resolve(cwd, DEFAULT_COMPANY_DATABASE_FILE),
    resolveCompanyDatabasePath({ cwd, env }),
  ])
  return [...paths]
}

export function isProtectedDatabasePath(databasePath, { cwd = process.cwd(), env = process.env } = {}) {
  const candidate = path.resolve(databasePath).toLowerCase()
  return protectedDatabasePaths({ cwd, env }).some(protectedPath => {
    const resolved = path.resolve(protectedPath).toLowerCase()
    return candidate === resolved || candidate.startsWith(`${resolved}-`)
  })
}

export function assertDisposableDatabasePath(databasePath, { cwd = process.cwd(), env = process.env } = {}) {
  if (!databasePath?.trim()) {
    throw new Error('E2E_DATABASE_FILE is required and must name a disposable SQLite database.')
  }
  const absolute = path.resolve(cwd, databasePath)
  if (path.dirname(absolute) !== path.resolve(cwd)) {
    throw new Error('The disposable E2E database must be a file directly inside the workspace root.')
  }
  if (isProtectedDatabasePath(absolute, { cwd, env })) {
    throw new Error(`Refusing to delete protected database path: ${absolute}`)
  }
  return absolute
}

export function resolveBackupDirectory({ cwd = process.cwd(), env = process.env } = {}) {
  const override = env.COMPANY_BACKUP_DIR?.trim()
  if (override) return path.resolve(cwd, override)

  const appData = process.platform === 'win32'
    ? env.LOCALAPPDATA?.trim()
    : env.XDG_DATA_HOME?.trim()
  if (appData) return path.resolve(appData, 'Sanjo Accounting', 'backups')
  if (process.platform === 'win32') return path.resolve(os.homedir(), 'AppData', 'Local', 'Sanjo Accounting', 'backups')
  return path.resolve(os.homedir(), '.local', 'share', 'Sanjo Accounting', 'backups')
}

function assertBackupDirectorySafe(backupDirectory, { cwd = process.cwd() } = {}) {
  const absolute = path.resolve(backupDirectory)
  const workspace = path.resolve(cwd)
  const disposableSegments = new Set(['.playwright', 'test-results', 'coverage', 'e2e', 'e2e-local-solo', 'tmp'])
  const relative = path.relative(workspace, absolute)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)) return absolute
  const segments = relative.split(path.sep).map(segment => segment.toLowerCase())
  if (segments.some(segment => disposableSegments.has(segment))) {
    throw new Error(`Company backups cannot be stored in a disposable test path: ${absolute}`)
  }
  return absolute
}

function quoteSqliteString(value) {
  return `'${value.replaceAll("'", "''")}'`
}

async function sha256(filePath) {
  const bytes = await readFile(filePath)
  return createHash('sha256').update(bytes).digest('hex')
}

function retentionLimit(env) {
  const configured = Number.parseInt(env.COMPANY_BACKUP_RETENTION ?? '', 10)
  if (!Number.isFinite(configured)) return DEFAULT_BACKUP_RETENTION
  return Math.min(MAX_BACKUP_RETENTION, Math.max(1, configured))
}

async function pruneBackups(backupDirectory, limit) {
  const entries = (await readdir(backupDirectory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && /^accounting-[0-9TZ-]+-[0-9]+-[0-9a-f]+\.db$/i.test(entry.name))
  const dated = await Promise.all(entries.map(async entry => ({
    entry,
    modified: (await stat(path.join(backupDirectory, entry.name))).mtimeMs,
  })))
  dated.sort((left, right) => right.modified - left.modified)
  for (const { entry } of dated.slice(limit)) {
    const dbPath = path.join(backupDirectory, entry.name)
    await rm(dbPath, { force: true })
    await rm(dbPath.replace(/\.db$/i, '.json'), { force: true })
  }
}

/**
 * Creates an online SQLite snapshot, checks its integrity, hashes the result,
 * and atomically publishes it outside the repository's disposable paths.
 * @param {{databasePath?: string, cwd?: string, env?: NodeJS.ProcessEnv}} options
 */
export async function createVerifiedBackup({ databasePath, cwd = process.cwd(), env = process.env } = {}) {
  const source = path.resolve(databasePath ?? resolveCompanyDatabasePath({ cwd, env }))
  const backupDirectory = assertBackupDirectorySafe(resolveBackupDirectory({ cwd, env }), { cwd })
  await mkdir(backupDirectory, { recursive: true })

  if (!existsSync(source)) {
    return { source, backupDirectory, verified: false, skipped: true, reason: 'source database does not exist yet' }
  }

  const stamp = new Date().toISOString().replaceAll(/[^0-9TZ-]/g, '')
  const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`
  const fileName = `accounting-${stamp}-${suffix}.db`
  const temporaryPath = path.join(backupDirectory, `${fileName}.part`)
  const backupPath = path.join(backupDirectory, fileName)
  const manifestPath = backupPath.replace(/\.db$/i, '.json')
  await rm(temporaryPath, { force: true })
  await rm(backupPath, { force: true })
  await rm(manifestPath, { force: true })

  const sourceHashBefore = await sha256(source)
  let sourceDatabase
  let backupDatabase
  try {
    sourceDatabase = new DatabaseSync(source)
    sourceDatabase.exec(`VACUUM INTO ${quoteSqliteString(temporaryPath)}`)
    sourceDatabase.close()
    sourceDatabase = undefined

    backupDatabase = new DatabaseSync(temporaryPath, { readOnly: true })
    const integrity = backupDatabase.prepare('PRAGMA integrity_check').get()
    backupDatabase.close()
    backupDatabase = undefined
    if (integrity?.integrity_check !== 'ok') {
      throw new Error(`SQLite integrity check failed for backup: ${String(integrity?.integrity_check ?? 'unknown')}`)
    }

    const sourceHashAfter = await sha256(source)
    if (sourceHashBefore !== sourceHashAfter) throw new Error('The company database changed while the backup was being created; migration was not started.')
    const databaseHash = await sha256(temporaryPath)
    const bytes = (await stat(temporaryPath)).size
    await rename(temporaryPath, backupPath)
    await writeFile(manifestPath, `${JSON.stringify({
      source,
      backupPath,
      databaseHash,
      bytes,
      sqliteIntegrity: 'ok',
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8')
    await pruneBackups(backupDirectory, retentionLimit(env))
    return { source, backupDirectory, backupPath, manifestPath, databaseHash, bytes, verified: true, skipped: false }
  } finally {
    try { sourceDatabase?.close() } catch { /* best effort cleanup */ }
    try { backupDatabase?.close() } catch { /* best effort cleanup */ }
    await rm(temporaryPath, { force: true })
  }
}

export function assertTestDatabaseSafe({ cwd = process.cwd(), env = process.env } = {}) {
  const configured = env.DATABASE_URL?.trim()
  if (!configured) return
  const databasePath = resolveDatabasePath(configured, cwd)
  if (databasePath && isProtectedDatabasePath(databasePath, { cwd, env })) {
    throw new Error(`Vitest cannot use the protected company database: ${databasePath}`)
  }
}
