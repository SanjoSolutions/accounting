import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const directory = mkdtempSync(join(tmpdir(), 'accounting-settings-'))
const databasePath = join(directory, 'test.db').replace(/\\/g, '/')
let updateSettings: typeof import('./index').updateSettings
let getSettings: typeof import('./index').getSettings
let prisma: typeof import('./persistence/client').prisma

beforeAll(async () => {
  const database = new DatabaseSync(databasePath)
  const migrations = resolve(process.cwd(), 'prisma', 'migrations')
  for (const name of readdirSync(migrations, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort()) database.exec(readFileSync(join(migrations, name, 'migration.sql'), 'utf8'))
  database.close()
  process.env.DATABASE_URL = `file:${databasePath}`
  process.env.AUDIT_INTEGRITY_SECRET = 'settings-test-audit-secret-value-32'
  ;({ updateSettings, getSettings } = await import('./index'))
  prisma = (await import('./persistence/client')).prisma
})

afterAll(async () => {
  await prisma.$disconnect()
  delete process.env.DATABASE_URL
  delete process.env.AUDIT_INTEGRITY_SECRET
  rmSync(directory, { recursive: true, force: true })
})

describe('persistent intra-community acquisition settings', () => {
  it('Given explicit acquisition controls, when settings are saved and reloaded, then separate named asset and liability controls persist', async () => {
    const configuration = { chart: 'SKR03' as const, rateBasisPoints: 1900 as const, inputVatAccountNumber: 1574, outputVatAccountNumber: 1774 }

    await updateSettings({ incomingEuAcquisitionAccounts: configuration }, 'tenant-acquisition', 'user-a')

    await expect(getSettings('tenant-acquisition')).resolves.toMatchObject({ incomingEuAcquisitionAccounts: configuration })
    await expect(prisma.ledgerAccount.findMany({ where: { ownerId: 'tenant-acquisition', number: { in: [1574, 1774] } }, orderBy: { number: 'asc' } })).resolves.toMatchObject([
      { number: 1574, name: 'Vorsteuer innergemeinschaftlicher Erwerb 19 %', category: 'ASSET', active: true },
      { number: 1774, name: 'Umsatzsteuer innergemeinschaftlicher Erwerb 19 %', category: 'LIABILITY', active: true },
    ])
    await expect(prisma.auditEvent.count({ where: { ownerId: 'tenant-acquisition', action: 'SETTINGS_CHANGED' } })).resolves.toBe(1)
  })

  it('Given §13b controls already use an account, when acquisition controls reuse it, then the settings write fails without changing persisted configuration', async () => {
    await updateSettings({ incomingReverseChargeAccounts: { chart: 'SKR03', rateBasisPoints: 1900, inputVatAccountNumber: 1577, outputVatAccountNumber: 1787 } }, 'tenant-distinct', 'user-a')

    await expect(updateSettings({ incomingEuAcquisitionAccounts: { chart: 'SKR03', rateBasisPoints: 1900, inputVatAccountNumber: 1577, outputVatAccountNumber: 1774 } }, 'tenant-distinct', 'user-a')).rejects.toThrow(/distinct from incoming §13b/)
    await expect(getSettings('tenant-distinct')).resolves.toMatchObject({ incomingReverseChargeAccounts: { inputVatAccountNumber: 1577, outputVatAccountNumber: 1787 }, incomingEuAcquisitionAccounts: undefined })
  })
})
