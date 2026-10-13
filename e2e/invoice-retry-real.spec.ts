import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { InvoiceRetryPage } from './invoice-retry-page'

for (const failure of ['lost-response', 'invalid-json-after-reload'] as const) {
  test(`Given a committed partial credit with ${failure}, when its saved request is retried, then exactly one credit and accounting result exist`, async ({ page, baseURL }, testInfo) => {
    test.skip(baseURL !== 'http://127.0.0.1:3126', 'Run with playwright.invoice-retry.config.ts and its isolated database/storage.')
    // This configuration starts a fresh server; never reuse the live company app.
    expect(testInfo.config.webServer?.env).toMatchObject({ DATABASE_URL: 'file:./credit-retry-playwright.db', DOCUMENT_STORAGE_ROOT: './.playwright/credit-retry/documents' })
    const email = `retry-${randomUUID()}@example.test`
    const invoices = new InvoiceRetryPage(page)
    await invoices.signUp('Invoice retry test', email, 'Synthetic-retry-password-2026!')
    await invoices.prepareIssuer()
    await invoices.initializeNumbering(2026)
    await invoices.issueStandardInvoice(2026)
    await invoices.prepareCredit()

    const requests: string[] = []
    let committedId = ''
    await page.route('**/api/tax/e-invoices/*/corrections', async route => {
      if (route.request().method() !== 'POST') return route.continue()
      requests.push(route.request().postData()!)
      const response = await route.fetch()
      expect(response.status()).toBe(201)
      const body = await response.json()
      expect(body).toMatchObject({ success: true, data: { invoiceNumber: '2026-000002' } })
      if (requests.length === 1) {
        committedId = body.data.id
        // The real POST has completed, including commercial and ledger writes.
        if (failure === 'lost-response') return route.abort('connectionreset')
        return route.fulfill({ response, body: '{invalid-json', contentType: 'application/json' })
      }
      expect(body.data.id).toBe(committedId)
      await route.fulfill({ response })
    })

    await invoices.submitCredit()
    await invoices.expectPending()
    await invoices.expectCreditFactsLocked()
    expect(requests).toHaveLength(1)
    assertSingleCredit(email, committedId)
    if (failure === 'invalid-json-after-reload') { await page.reload(); await invoices.expectPending() }
    await page.screenshot({ path: testInfo.outputPath('pending-desktop.png'), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: testInfo.outputPath('pending-mobile.png'), fullPage: true })
    await page.setViewportSize({ width: 1280, height: 720 })
    await invoices.retryAndExpectConfirmed()
    expect(requests).toHaveLength(2)
    expect(requests[1]).toBe(requests[0])
    assertSingleCredit(email, committedId)
  })
}

test('Given a definitively rejected credit, when its amount is corrected, then a fresh key issues the corrected intent', async ({ page, baseURL }, testInfo) => {
  test.skip(baseURL !== 'http://127.0.0.1:3126', 'Run with playwright.invoice-retry.config.ts and its isolated database/storage.')
  expect(testInfo.config.webServer?.env).toMatchObject({ DATABASE_URL: 'file:./credit-retry-playwright.db', DOCUMENT_STORAGE_ROOT: './.playwright/credit-retry/documents' })
  const email = `rejected-${randomUUID()}@example.test`
  const invoices = new InvoiceRetryPage(page)
  await invoices.signUp('Rejected credit test', email, 'Synthetic-retry-password-2026!')
  await invoices.prepareIssuer(); await invoices.initializeNumbering(2026); await invoices.issueStandardInvoice(2026)
  await invoices.prepareCredit('200.00')
  const requests: Array<{ requestKey: string; netAmountCents: number }> = []
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/corrections')) requests.push(request.postDataJSON()) })
  const rejectedResponse = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/corrections'))
  await invoices.submitCredit()
  expect(await (await rejectedResponse).json()).toMatchObject({ success: false, requestRejected: true })
  await invoices.reviseRejectedCredit('20.00')
  const acceptedResponse = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/corrections'))
  await invoices.submitCredit(); await invoices.expectCreditConfirmed()
  const accepted = await (await acceptedResponse).json()
  expect(requests).toHaveLength(2)
  expect(requests[1].requestKey).not.toBe(requests[0].requestKey)
  expect(requests.map(request => request.netAmountCents)).toEqual([20000, 2000])
  assertSingleCredit(email, accepted.data.id)
})

function assertSingleCredit(email: string, creditId: string) {
  // Read only this worktree's explicitly disposable fixture database.
  const database = new DatabaseSync(resolve('credit-retry-playwright.db'), { readOnly: true })
  try {
    const owner = database.prepare('SELECT id FROM User WHERE email = ?').get(email) as { id: string }
    const rows = (sql: string) => database.prepare(sql).all(owner.id)
    expect(rows('SELECT invoiceNumber FROM InvoiceNumberReservation WHERE ownerId = ? ORDER BY sequenceValue')).toEqual([{ invoiceNumber: '2026-000001' }, { invoiceNumber: '2026-000002' }])
    expect(rows('SELECT nextValue FROM InvoiceNumberSequence WHERE ownerId = ?')).toEqual([{ nextValue: 3 }])
    expect(rows("SELECT id, invoiceNumber FROM StructuredInvoice WHERE ownerId = ? AND kind = 'credit-note'")).toEqual([{ id: creditId, invoiceNumber: '2026-000002' }])
    expect(rows("SELECT structuredInvoiceId, grossAmountCents FROM CommercialDocument WHERE ownerId = ? AND kind = 'CREDIT_NOTE'")).toEqual([{ structuredInvoiceId: creditId, grossAmountCents: 2380 }])
    expect(rows("SELECT id FROM JournalEntry WHERE ownerId = ? AND source = 'OUTGOING_CREDIT_NOTE'")).toHaveLength(1)
    expect(rows('SELECT amountCents FROM CorrectionNetting WHERE ownerId = ?')).toEqual([{ amountCents: 2380 }])
    expect(rows("SELECT originalAmountCents, allocatedAmountCents FROM OpenItem WHERE ownerId = ? AND side = 'DEBIT'")).toEqual([{ originalAmountCents: 11900, allocatedAmountCents: 2380 }])
    expect(rows('SELECT netBaseCents, taxCents FROM VatPostingRecord WHERE ownerId = ? AND netBaseCents < 0')).toEqual([{ netBaseCents: -2000, taxCents: -380 }])
  } finally { database.close() }
}
