import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test, expect } from '@playwright/test'
import { AnnualClosePage } from './annual-close-page'

const invoicePdf = readFileSync(new URL('./fixtures/invoice.pdf', import.meta.url))

test.describe('real annual close', () => {
  test.setTimeout(60_000)

  test('creates, reviews and immutably locks an expired 2026 fiscal year', async ({ browser }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL as string
    const context = await browser.newContext({ baseURL })
    await context.addCookies([{ name: 'NEXT_LOCALE', value: 'en', url: baseURL }])
    const page = await context.newPage()
    const email = `annual-close-${randomUUID()}@example.test`
    const signUp = await page.request.post('/api/auth/sign-up/email', {
      headers: { Origin: baseURL },
      data: { name: 'Annual Close E2E', email, password: 'Annual-close-password-2026!' },
    })
    expect(signUp.ok(), `${signUp.status()} ${await signUp.text()}`).toBe(true)

    const annualClose = new AnnualClosePage(page)
    await annualClose.createExpiredShortFiscalYear2026()
    await annualClose.postRevenueWithEvidence(invoicePdf)

    const beforeCloseResponse = await page.request.get('/api/booking-records?year=2026')
    expect(beforeCloseResponse.ok()).toBe(true)
    const beforeClose = await beforeCloseResponse.json()
    expect(beforeClose).toMatchObject({
      fiscalYear: { year: 2026, status: 'OPEN' },
      statements: {
        assetsCents: 11900,
        revenueCents: 11900,
        netIncomeCents: 11900,
        balanceDifferenceCents: 0,
      },
    })
    expect(beforeClose.entries).toHaveLength(1)

    await annualClose.reviewAndLock2026()

    const postedEntry = beforeClose.entries[0]
    const bankLine = postedEntry.lines.find((line: { account: { number: number } }) => line.account.number === 1200)
    const revenueLine = postedEntry.lines.find((line: { account: { number: number } }) => line.account.number === 8400)
    const rejected = await annualClose.attemptPosting({
      fiscalYear: 2026,
      bookingDate: '2026-02-01',
      description: 'Must be rejected after close',
      documentIds: [postedEntry.documents[0].id],
      lines: [
        { accountId: bankLine.account.id, debitCents: 100, creditCents: 0 },
        { accountId: revenueLine.account.id, debitCents: 0, creditCents: 100 },
      ],
    })
    expect(rejected.status()).toBe(400)
    expect((await rejected.json()).issues.join(' ')).toMatch(/gesperrt|Wiedereröffnete Geschäftsjahre/)

    const afterRejectedPostResponse = await page.request.get('/api/booking-records?year=2026')
    expect(afterRejectedPostResponse.ok()).toBe(true)
    const afterRejectedPost = await afterRejectedPostResponse.json()
    expect(afterRejectedPost.fiscalYear).toMatchObject({ year: 2026, status: 'CLOSED' })
    expect(afterRejectedPost.fiscalYear.lockedAt).toEqual(expect.any(String))
    expect(afterRejectedPost.entries).toHaveLength(1)
    expect(afterRejectedPost.statements).toEqual(beforeClose.statements)

    await context.close()
  })
})
