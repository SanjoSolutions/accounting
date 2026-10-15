import { randomUUID, createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from '@playwright/test'
import { AuthenticationPage } from './pages'
import { EBalanceLifecyclePage } from './ebilanz-lifecycle-page'

const databasePath = path.resolve('issue19-playwright.db')
const storagePath = path.resolve('.playwright/issue19-documents')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

test('given historical reports, when an owner downloads a version, then retained bytes and audited access are preserved', async ({ page, baseURL }, testInfo) => {
  // Verify all three isolation boundaries before any browser action.
  expect(baseURL).toBe('http://127.0.0.1:3219')
  expect(realpathSync(databasePath)).toBe(databasePath)
  expect(realpathSync(storagePath)).toBe(storagePath)
  expect(path.basename(databasePath)).toBe('issue19-playwright.db')
  await page.context().addCookies([{ name: 'NEXT_LOCALE', value: 'en', url: baseURL! }])
  await page.goto('/sign-up')
  await new AuthenticationPage(page).signUp('Synthetic report reviewer', `lifecycle-${randomUUID()}@example.test`, 'Synthetic-review-password-2026!')
  await expect(page).toHaveURL('/')
  const ownerId = (await (await page.request.get('/api/access')).json()).data.activeTenantId as string
  const db = new DatabaseSync(databasePath)
  db.exec('PRAGMA busy_timeout = 15000')
  const existingPeriod = db.prepare('SELECT id FROM FiscalYear WHERE ownerId = ? AND year = 2026').get(ownerId) as { id: string } | undefined
  const fiscalYearId = existingPeriod?.id ?? randomUUID()
  const reportId = randomUUID()
  const xml = '<?xml version="1.0"?><synthetic-historical-report/>'
  const storageKey = `reports/${reportId}.xml`
  mkdirSync(path.join(storagePath, 'reports'), { recursive: true })
  writeFileSync(path.join(storagePath, storageKey), xml)
  if (!existingPeriod) db.prepare('INSERT INTO FiscalYear (id, ownerId, year, startsAt, endsAt, status, updatedAt) VALUES (?, ?, 2026, ?, ?, ?, ?)').run(fiscalYearId, ownerId, Date.parse('2026-01-01'), Date.parse('2026-12-31'), 'OPEN', Date.now())
  db.prepare('INSERT INTO EBalanceLifecycleReport (id, ownerId, fiscalYearId, version, status, taxonomyVersion, profileSnapshot, reportPayload, reportXml, reportChecksum, storageKey, createdBy) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)').run(reportId, ownerId, fiscalYearId, 'PREPARED', '6.9', '{}', '{}', xml, hash(xml), storageKey, ownerId)
  db.prepare('INSERT INTO RetainedArtifact (id, ownerId, objectType, objectId, version, retentionClass, contentHash, provenance, storageKey, periodEndsAt, retainUntil) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)').run(randomUUID(), ownerId, 'EBalanceLifecycleReport', reportId, 'TAX_RECORD', hash(xml), 'Synthetic historical fixture; not filing-ready', storageKey, Date.parse('2026-12-31'), Date.parse('2036-12-31'))
  try {
    const workspace = new EBalanceLifecyclePage(page)
    await workspace.open()
    await expect(workspace.panel).toContainText('STALE')
    await expect(workspace.panel.getByRole('button', { name: 'Approve report', exact: true })).toHaveCount(0)
    const download = await workspace.download(1)
    expect(download.suggestedFilename()).toBe('e-bilanz-v1.xml')
    expect(readFileSync((await download.path())!, 'utf8')).toBe(xml)
    expect(db.prepare('SELECT count(*) AS n FROM AuditEvent WHERE ownerId = ? AND actorId = ? AND action = ?').get(ownerId, ownerId, 'E_BILANZ_REPORT_ACCESSED')).toEqual({ n: 1 })
    expect(db.prepare('SELECT count(*) AS n FROM EBalanceSubmission WHERE ownerId = ?').get(ownerId)).toEqual({ n: 0 })
    await workspace.panel.screenshot({ path: testInfo.outputPath('lifecycle-desktop.png') })
    await page.setViewportSize({ width: 390, height: 844 })
    await workspace.panel.screenshot({ path: testInfo.outputPath('lifecycle-mobile.png') })

    // Visual-only synthetic current state for the review form; no source gate
    // or approval API is bypassed, and no mutation is attempted with this view.
    await page.route('**/api/compliance/e-bilanz?*', async route => {
      const response = await route.fetch()
      const body = await response.json()
      body.data.reports = body.data.reports.map((report: Record<string, unknown>) => ({ ...report, sourceStatus: 'CURRENT' }))
      await route.fulfill({ response, json: body })
    })
    await workspace.open()
    await expect(workspace.panel.getByLabel('Review note')).toBeVisible()
    await workspace.panel.screenshot({ path: testInfo.outputPath('review-mobile.png') })
    await page.setViewportSize({ width: 1280, height: 900 })
    await workspace.panel.screenshot({ path: testInfo.outputPath('review-desktop.png') })
  } finally { db.close() }
})
