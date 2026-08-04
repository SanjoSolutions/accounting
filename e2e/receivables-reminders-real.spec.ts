import { randomUUID } from 'node:crypto'
import { test } from '@playwright/test'
import { StructuredInvoicesPage } from './structured-invoices-page'
import { ReceivablesRemindersPage } from './receivables-reminders-page'

test.describe('real manual receivables reminder journey', () => {
  test('Given an overdue UG customer invoice, when a reminder is issued, explicitly approved for real email delivery, reloaded and cancelled, then provider and append-only history remain while the open balance is unchanged', async ({ page }) => {
    const unique = randomUUID().slice(0, 8); const invoices = new StructuredInvoicesPage(page); const reminders = new ReceivablesRemindersPage(page)
    await page.request.delete('http://127.0.0.1:3200/captures')
    await invoices.signUp(`Reminder ${unique}`, `reminder-${unique}@example.test`, 'playwright-password-2026')
    await invoices.configureIssuerAndCompany(); await invoices.initializeNumbering(2026); await invoices.issueStandardInvoice(2026, '2026-06-01')
    await reminders.openAndIssue('2026-000001'); await reminders.approveAndDeliver('2026-000001', `billing-${unique}@customer.example`); await reminders.proveReloadHistoryAndAppendOnlyCancellation('2026-000001')
  })
})
