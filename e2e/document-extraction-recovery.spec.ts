import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from '@playwright/test'
import { DocumentExtractionPage } from './document-extraction-page'

test('Given an abandoned persisted extraction, when the user reopens and retries it, then the recovered invoice can be reviewed and confirmed', async ({ page, baseURL }, testInfo) => {
  // Only the dedicated config owns this database, document store and port.
  test.skip(baseURL !== 'http://127.0.0.1:3124', 'Use playwright.document-extraction.config.ts for the isolated recovery fixture.')
  const server = testInfo.config.webServer
  expect(server?.env).toMatchObject({ DATABASE_URL: 'file:./extraction-playwright.db', DOCUMENT_STORAGE_ROOT: './.playwright/extraction-documents', DISPOSABLE_DATABASE: 'true' })
  const databasePath = resolve('extraction-playwright.db')
  expect(databasePath).not.toBe(resolve('accounting.db'))

  const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const extraction = new DocumentExtractionPage(page)
  await extraction.signUp(`Recovery ${unique}`, `recovery-${unique}@example.test`, 'playwright-password-2026')
  const pdf = readFileSync(new URL('./fixtures/invoice.pdf', import.meta.url))
  const documentId = await extraction.uploadForRecovery(pdf)

  const database = new DatabaseSync(databasePath)
  try {
    const document = database.prepare('SELECT ownerId FROM DocumentRecord WHERE id = ?').get(documentId) as { ownerId: string }
    database.prepare(`INSERT INTO DocumentExtraction (id, ownerId, documentId, status, provider, providerVersion, inputHash, attempt, attemptId, leaseExpiresAt, updatedAt) VALUES (?, ?, ?, 'PROCESSING', 'local-pdf-text', '1', ?, 7, 'abandoned-e2e-attempt', ?, ?)`).run(
      `recovery-${unique}`, document.ownerId, documentId, createHash('sha256').update(pdf).digest('hex'), new Date('2000-01-01').getTime(), new Date('2000-01-01').getTime(),
    )
    await extraction.reopenInterruptedExtraction()
    await page.screenshot({ path: testInfo.outputPath('recovery-desktop.png'), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: testInfo.outputPath('recovery-mobile.png'), fullPage: true })
    await page.setViewportSize({ width: 1280, height: 720 })
    await extraction.retryInterruptedExtraction()
    await extraction.reviewAndProveDurability()
    expect(database.prepare('SELECT status, attempt, leaseExpiresAt FROM DocumentExtraction WHERE documentId = ?').get(documentId)).toMatchObject({ status: 'CONFIRMED', attempt: 8, leaseExpiresAt: null })
    const events = database.prepare("SELECT action FROM AuditEvent WHERE objectId = ? AND objectType = 'DocumentExtraction'").all(documentId) as { action: string }[]
    expect(events.map(event => event.action).sort()).toEqual(['DOCUMENT_EXTRACTION_COMPLETED', 'DOCUMENT_EXTRACTION_CONFIRMED', 'DOCUMENT_EXTRACTION_RECOVERED'])
  } finally { database.close() }
})
