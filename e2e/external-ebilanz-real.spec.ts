import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test, expect } from '@playwright/test'
import { AuthenticationPage } from './pages'
import { ExternalEBalancePage } from './external-ebilanz-page'
import { createExternalPackage, hashBytes, type ExternalEBalanceSource } from '../src/server/externalEBalance/adapter'

const databasePath = path.resolve('external-playwright.db')
const storagePath = path.resolve('.playwright/external-documents')
function assertIsolation(baseURL: string | undefined) {
  expect(baseURL).toBe('http://127.0.0.1:3112')
  expect(realpathSync(databasePath)).toBe(databasePath)
  expect(realpathSync(storagePath)).toBe(storagePath)
  expect(path.basename(databasePath)).not.toBe('accounting.db')
}

// Deliberately historical evidence, not a fictional currently approved close.
// The real source gate must reject regeneration while allowing exact archived downloads.
function retainHistoricalFixture(ownerId: string) {
  const database = new DatabaseSync(databasePath)
  try {
    database.exec('PRAGMA busy_timeout = 15000')
    let period = database.prepare('SELECT id FROM FiscalYear WHERE ownerId = ? AND year = 2026').get(ownerId) as { id: string } | undefined
    if (!period) {
      period = { id: randomUUID() }
      database.prepare('INSERT INTO FiscalYear (id, ownerId, year, startsAt, endsAt, status, updatedAt) VALUES (?, ?, 2026, ?, ?, ?, ?)').run(period.id, ownerId, new Date('2026-01-01Z').getTime(), new Date('2026-12-31Z').getTime(), 'OPEN', Date.now())
    }
    const source: ExternalEBalanceSource = { fiscalYearId: period.id, year: 2026, startsAt: '2026-01-01', endsAt: '2026-12-31', closeGenerationId: 'historical-synthetic-generation', sourceFingerprint: 'a'.repeat(64), taxonomyVersion: '6.9', accounts: [
      { accountId: 'bank', number: 1200, name: 'Synthetische Bank', category: 'ASSET', eBilanzPosition: 'bs.ass.currAss.cashEquiv.bank', debitCents: 10000, creditCents: 0, balanceCents: 10000 },
      { accountId: 'capital', number: 800, name: 'Synthetisches Kapital', category: 'EQUITY', eBilanzPosition: 'bs.eqLiab.equity.subscribed', debitCents: 0, creditCents: 10000, balanceCents: -10000 },
    ], dataset: { synthetic: true, purpose: 'Historical download fixture, not filing-ready evidence' }, xbrl: '<?xml version="1.0"?><synthetic-fixture/>', xbrlPackage: new Uint8Array([80, 75]) }
    return [1, 2].map(version => {
      const id = randomUUID(); const { archive } = createExternalPackage(source, version)
      const key = `external-fixtures/${id}.zip`; mkdirSync(path.dirname(path.join(storagePath, key)), { recursive: true }); writeFileSync(path.join(storagePath, key), archive)
      database.prepare('INSERT INTO RetainedArtifact (id, ownerId, objectType, objectId, version, retentionClass, contentHash, provenance, storageKey, periodEndsAt, retainUntil) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, ownerId, 'ExternalEBalancePackage', period!.id, version, 'TAX_RECORD', hashBytes(archive), 'Synthetic historical Playwright fixture', key, new Date('2026-12-31Z').getTime(), new Date('2036-12-31Z').getTime())
      return { id, archive, hash: hashBytes(archive) }
    })
  } finally { database.close() }
}

test('Given historical retained versions without local ERiC, when the owner previews, downloads and attaches evidence, then exact bytes and unauthenticated status are preserved', async ({ page, baseURL }, testInfo) => {
  assertIsolation(baseURL)
  await page.context().addCookies([{ name: 'NEXT_LOCALE', value: 'en', url: baseURL! }])
  await page.goto('/sign-up')
  await new AuthenticationPage(page).signUp('External export synthetic owner', `external-${randomUUID()}@example.test`, 'Synthetic-external-password-2026!')
  await expect(page).toHaveURL('/')
  const access = await (await page.request.get('/api/access')).json()
  const ownerId = access.data.activeTenantId as string
  const versions = retainHistoricalFixture(ownerId)
  const external = new ExternalEBalancePage(page)
  await external.open()
  await expect(page.getByLabel('Filing method')).toHaveValue('external')
  await expect(external.panel.getByRole('button', { name: 'Save new export version' })).toBeDisabled()
  await external.select(versions[0].id)
  await expect(external.panel).toContainText('This version is historical')
  await external.previewInstructions()
  const download = await external.download()
  expect(download.suggestedFilename()).toBe('e-bilanz-extern-2026-v1.zip')
  const downloaded = readFileSync((await download.path())!)
  expect(createHash('sha256').update(downloaded).digest('hex')).toBe(versions[0].hash)
  expect(downloaded).toEqual(Buffer.from(versions[0].archive))
  await external.attachManualClaim()
  const db = new DatabaseSync(databasePath)
  try {
    expect(db.prepare('SELECT count(*) AS n FROM EBalanceSubmission WHERE ownerId = ?').get(ownerId)).toEqual({ n: 0 })
    const evidence = db.prepare('SELECT provenance FROM RetainedArtifact WHERE ownerId = ? AND objectType = ?').get(ownerId, 'ExternalEBalanceEvidence') as { provenance: string }
    expect(JSON.parse(evidence.provenance)).toMatchObject({ trust: 'USER_SUPPLIED_UNAUTHENTICATED', packageHash: versions[0].hash })
  } finally { db.close() }
  await external.select(versions[1].id)
  await expect(external.panel.getByRole('link', { name: 'Download evidence' })).toHaveCount(0)
  await external.select(versions[0].id)
  await page.screenshot({ path: testInfo.outputPath('external-ebilanz-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: testInfo.outputPath('external-ebilanz-mobile.png'), fullPage: true })
})
