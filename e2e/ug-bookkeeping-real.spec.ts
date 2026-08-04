import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from '@playwright/test'
import { UgBookkeepingPage } from './ug-bookkeeping-page'

const invoicePdf = readFileSync(new URL('./fixtures/invoice.pdf', import.meta.url))

test.describe('real UG bookkeeping', () => {
  test.setTimeout(60_000)
  test.use({ storageState: { cookies: [], origins: [] } })

  test('onboards, rejects an unbalanced posting, and persists an evidenced journal entry and statements', async ({ page }) => {
    const bookkeeping = new UgBookkeepingPage(page)
    await bookkeeping.signUp(
      'UG Bookkeeping E2E',
      `ug-bookkeeping-${randomUUID()}@example.test`,
      'UG-bookkeeping-password-2026!',
    )
    await bookkeeping.uploadReceipt(invoicePdf)
    await bookkeeping.proveUnbalancedPostingIsBlocked()
    await bookkeeping.balanceAndPost()
    await bookkeeping.expectPersistedJournalEntry()
    await bookkeeping.expectPersistedStatements()
  })
})
