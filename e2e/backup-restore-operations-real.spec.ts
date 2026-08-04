import { readFile, readFileSync } from 'node:fs'
import { test, expect } from '@playwright/test'
import { promisify } from 'node:util'
import { StructuredInvoicesPage } from './structured-invoices-page'
import { ReceivablesRemindersPage } from './receivables-reminders-page'
import { BankingPage } from './banking-page'
import { DocumentExtractionPage } from './document-extraction-page'
import { FixedAssetsPage } from './fixed-assets-page'

const read = promisify(readFile)
const invoicePdf = readFileSync(new URL('./fixtures/invoice.pdf', import.meta.url))

test.describe('real tenant backup and isolated restore operations', () => {
  test('Given a representative UG accounting graph, when an operator backs up, downloads and restores it, then fixity and every critical slice survive while tampering is rejected atomically', async ({ page }) => {
    test.setTimeout(180_000)
    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const invoices = new StructuredInvoicesPage(page)
    await invoices.signUp(`Backup operator ${unique}`, `backup-${unique}@example.test`, 'playwright-password-2026')
    await invoices.configureIssuerAndCompany(); await invoices.initializeNumbering(2026); await invoices.issueStandardInvoice(2026, '2026-07-01')
    await new ReceivablesRemindersPage(page).openAndIssue('2026-000001')
    const bank = new BankingPage(page); await bank.open(); await bank.configureAccount(); await bank.importAndReview()
    const incoming = new DocumentExtractionPage(page); await incoming.uploadAndExtract(invoicePdf); await incoming.confirmAndPostPayable()
    const assets = new FixedAssetsPage(page); await assets.uploadEvidence(invoicePdf); await assets.registerAndPost()

    const overview = await api(page, '/api/compliance')
    const tenantId = overview.data.tenantId as string
    await api(page, '/api/compliance', { action: 'policy.configure', allowedStorageRegions: ['DE'], operatorIds: [tenantId], recoveryPointObjectiveMinutes: 60, recoveryTimeObjectiveMinutes: 60, backupKeyId: 'e2e-backup-key', reason: 'Establish tested backup operations' })
    const created = await api(page, '/api/compliance', { action: 'backup.create', region: 'DE', reason: 'Full tenant recovery point' })
    const backupId = created.data.id as string

    await page.goto('/compliance'); await expect(page.getByRole('link', { name: 'Download latest encrypted backup' })).toBeVisible()
    const downloadPromise = page.waitForEvent('download'); await page.getByRole('link', { name: 'Download latest encrypted backup' }).click(); const download = await downloadPromise
    const downloadPath = await download.path(); expect(downloadPath).toBeTruthy(); const original = await read(downloadPath!)
    const encrypted = JSON.parse(original.toString()) as { encrypted: string }; encrypted.encrypted = `${encrypted.encrypted[0] === 'A' ? 'B' : 'A'}${encrypted.encrypted.slice(1)}`
    const tampered = await rawBackup(page, backupId, Buffer.from(JSON.stringify(encrypted)))
    expect(tampered.status).toBe(409); expect(tampered.body.error).toMatch(/verification failed|match/i)
    const afterTamper = await api(page, '/api/compliance')
    expect(afterTamper.data.operations.backups.find((backup: { id: string }) => backup.id === backupId).status).toBe('CREATED')

    const verifiedUpload = await rawBackup(page, backupId, original)
    expect(verifiedUpload.status).toBe(200)
    expect(verifiedUpload.body.data).toMatchObject({ isolatedRestore: true, databaseHash: expect.stringMatching(/^[a-f0-9]{64}$/), objectStoreHash: expect.stringMatching(/^[a-f0-9]{64}$/), isolatedDatabase: { entries: expect.any(Number), documents: expect.any(Number), openItems: expect.any(Number), bankStatements: 1, bankTransactions: 1, documentExtractions: expect.any(Number), receivablesReminders: 1, fixedAssets: 1, vatPostings: expect.any(Number) } })
    expect(verifiedUpload.body.data.isolatedDatabase.entries).toBeGreaterThanOrEqual(4)
    expect(verifiedUpload.body.data.isolatedDatabase.documents).toBeGreaterThanOrEqual(3)
    expect(verifiedUpload.body.data.isolatedDatabase.openItems).toBeGreaterThanOrEqual(2)
    expect(verifiedUpload.body.data.isolatedDatabase.documentExtractions).toBeGreaterThanOrEqual(1)
    expect(verifiedUpload.body.data.isolatedDatabase.vatPostings).toBeGreaterThanOrEqual(2)

    const certified = await api(page, '/api/compliance', { action: 'backup.verify-restore', backupId, measuredRestoreMinutes: 0, reason: 'Operator-observed isolated recovery exercise' })
    expect(certified.data).toMatchObject({ status: 'RESTORE_VERIFIED', isolatedRestore: true, isolatedDatabase: { receivablesReminders: 1, fixedAssets: 1, bankStatements: 1 } })
    await page.reload(); await expect(page.getByText('RESTORE_VERIFIED')).toBeVisible()
  })
})

async function api(page: import('@playwright/test').Page, path: string, body?: Record<string, unknown>) {
  const result = await page.evaluate(async ({ path, body }) => { const response = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined); return { status: response.status, body: await response.json() } }, { path, body })
  expect(result.status, JSON.stringify(result.body)).toBeLessThan(400); return result.body
}
async function rawBackup(page: import('@playwright/test').Page, backupId: string, content: Buffer) {
  return page.evaluate(async ({ backupId, base64 }) => { const response = await fetch(`/api/compliance/backups/${backupId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: Uint8Array.from(atob(base64), character => character.charCodeAt(0)) }); return { status: response.status, body: await response.json() } }, { backupId, base64: content.toString('base64') })
}
