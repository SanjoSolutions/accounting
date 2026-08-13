import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it, test, vi } from 'vitest'

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

describe('initial company profile onboarding', () => {
  const profile = {
    companyName: 'New User GmbH', legalForm: 'GMBH', taxNumber: '12/345/67890', taxOffice: 'Berlin', vatRegime: 'STANDARD', vatFilingFrequency: 'QUARTERLY',
    activity: 'Software', sizeClass: 'SMALL', chart: 'SKR03', elections: [],
    registeredAddress: { streetAndHouseNumber: 'Teststraße 1', zipCode: '10115', city: 'Berlin', country: 'DE' },
  }

  test('Given unchanged company facts entered today, when prior validity is explicitly confirmed, then an earlier immutable version is appended', async () => {
    const today = new Date().toISOString().slice(0, 10)
    await updateSettings({ companyProfile: profile, companyProfileEffectiveFrom: today, changeReason: 'Initial app setup' }, 'tenant-profile-onboarding', 'user-a')
    await updateSettings({ companyProfile: { ...profile }, companyProfileEffectiveFrom: '2020-01-01', confirmProfilePreviouslyValid: true, changeReason: 'Existing company details verified from records' }, 'tenant-profile-onboarding', 'user-a')

    const versions = await prisma.companyProfileVersion.findMany({ where: { ownerId: 'tenant-profile-onboarding' }, orderBy: { effectiveFrom: 'asc' } })
    expect(versions.map(version => version.effectiveFrom.toISOString().slice(0, 10))).toEqual(['2020-01-01', today])
    expect(versions.every(version => JSON.parse(version.payload).vatFilingFrequency === 'QUARTERLY')).toBe(true)
    await expect(prisma.accountMappingVersion.count({ where: { ownerId: 'tenant-profile-onboarding', chartId: 'SKR03', effectiveFrom: new Date('2020-01-01') } })).resolves.toBeGreaterThan(0)
    await expect(prisma.auditEvent.findFirst({ where: { ownerId: 'tenant-profile-onboarding', action: 'COMPANY_PROFILE_PRIOR_VALIDITY_CONFIRMED' } })).resolves.not.toBeNull()
  })

  test('Given an existing profile, when changed facts are backdated, then onboarding confirmation cannot bypass transition controls', async () => {
    const today = new Date().toISOString().slice(0, 10)
    await updateSettings({ companyProfile: profile, companyProfileEffectiveFrom: today, changeReason: 'Initial app setup' }, 'tenant-profile-backdate-rejected', 'user-a')
    await expect(updateSettings({ companyProfile: { ...profile, taxOffice: 'Hamburg' }, companyProfileEffectiveFrom: '2020-01-01', confirmProfilePreviouslyValid: true, changeReason: 'Attempted retroactive change' }, 'tenant-profile-backdate-rejected', 'user-a')).rejects.toThrow(/initial or unchanged profile facts/)
    await expect(prisma.companyProfileVersion.count({ where: { ownerId: 'tenant-profile-backdate-rejected' } })).resolves.toBe(1)
  })
})
