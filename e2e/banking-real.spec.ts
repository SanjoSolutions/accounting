import { randomUUID } from 'node:crypto'
import { test } from '@playwright/test'
import { BankingPage } from './banking-page'
import { StructuredInvoicesPage } from './structured-invoices-page'

test.describe('real CAMT bank statement review journey', () => {
  test('Given an issued invoice, when a smaller booked CAMT receipt is imported, then review posts a durable partial allocation and reversal without false reconciliation', async ({ page }) => {
    const unique = randomUUID().slice(0, 8); const invoices = new StructuredInvoicesPage(page)
    await invoices.signUp(`Banking ${unique}`, `banking-${unique}@example.test`, 'playwright-password-2026')
    await invoices.configureIssuerAndCompany(); await invoices.initializeNumbering(2026); await invoices.issueStandardInvoice(2026)
    const banking = new BankingPage(page); await banking.open(); await banking.configureAccount(); await banking.importAndReview(); await banking.confirmAndProvePosting(); await banking.provePersistenceAndDeduplication(); await banking.reverseAndProveAppendOnlyCorrection()
  })

  test('Given two invoices for one customer, when one receipt covers both plus an overpayment, then review visibly splits exact cents and retains durable customer credit', async ({ page }) => {
    const unique = randomUUID().slice(0, 8); const invoices = new StructuredInvoicesPage(page)
    await invoices.signUp(`Bank Split ${unique}`, `banking-split-${unique}@example.test`, 'playwright-password-2026')
    await invoices.configureIssuerAndCompany(); await invoices.initializeNumbering(2026)
    await invoices.issueStandardInvoice(2026, '2026-08-04', 1); await invoices.issueStandardInvoice(2026, '2026-08-04', 2)
    const banking = new BankingPage(page); await banking.open(); await banking.configureAccount(); await banking.importSplitOverpaymentAndReview(); await banking.confirmSplitOverpaymentAndProvePersistence()
  })
})
