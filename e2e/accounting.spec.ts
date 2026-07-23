import { readFileSync } from 'node:fs'
import { test, expect } from './fixtures'
import { currentYear, fulfillJson, mockAccounting, openWorkspace } from './mocks'

const invoicePdf = readFileSync(new URL('./fixtures/invoice.pdf', import.meta.url))

test.describe('accounting workspaces', () => {
  test.beforeEach(async ({ page }) => {
    await mockAccounting(page)
  })

  test('viewing dashboard metrics and the posted journal', async ({ app, page }) => {
    await app.open('/')
    await expect(page.getByRole('region', { name: 'Metrics' })).toContainText('119,00')

    await app.followNavigation('Journal')
    await expect(page.getByRole('heading', { name: 'Posted entries' })).toBeVisible()
    await expect(page.getByText('Opening transaction')).toBeVisible()
    await expect(page.getByRole('link', { name: 'invoice.pdf' })).toBeVisible()
  })

  test('uploading a PDF document and posting a balanced booking', async ({ bookings, page }) => {
    let postedBody: Record<string, unknown> | undefined
    await page.route('**/api/booking-records', async route => {
      if (route.request().method() !== 'POST') return route.fallback()
      postedBody = route.request().postDataJSON()
      await fulfillJson(route, { data: { id: 'entry-2' } }, 201)
    })

    await bookings.open('/bookings')
    const previewResponse = page.waitForResponse(response =>
      response.request().resourceType() === 'document'
      && /\/api\/documents\/[^/]+\/file$/.test(new URL(response.url()).pathname),
    )
    const thumbnailResponse = page.waitForResponse(response =>
      /\/api\/documents\/[^/]+\/thumbnail$/.test(new URL(response.url()).pathname),
    )
    await page.locator('.document-actions input[type="file"]').setInputFiles({
      name: 'booking-invoice.pdf',
      mimeType: 'application/pdf',
      buffer: invoicePdf,
    })
    await expect(page.getByRole('button', { name: 'booking-invoice' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('iframe[title="booking-invoice.pdf"]')).toHaveAttribute('src', /\/api\/documents\/[^/]+\/file$/)
    expect((await previewResponse).headers()['content-type']).toContain('application/pdf')
    expect((await thumbnailResponse).headers()['content-type']).toContain('image/webp')
    await expect.poll(() => page.locator('.document-card img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await bookings.completeBalancedPosting()
    await expect(page.getByText('Difference').locator('..')).toContainText('0,00')
    await page.getByRole('button', { name: 'Post', exact: true }).click()

    await expect(page.getByRole('status')).toContainText('transaction has been posted')
    expect(postedBody).toMatchObject({
      fiscalYear: currentYear,
      description: 'Office supplies',
      documentIds: [expect.any(String)],
      lines: [
        { accountId: 'office', debitCents: 11900, creditCents: 0 },
        { accountId: 'bank', debitCents: 0, creditCents: 11900 },
      ],
    })
  })

  test('resizing the document preview and preserving a draft', async ({ bookings, page }) => {
    await bookings.open('/bookings')
    const separator = page.getByRole('separator', { name: 'Resize document preview and posting columns' })
    await separator.press('End')
    await expect(separator).toHaveAttribute('aria-valuenow', '75')

    await page.getByLabel('Posting text').fill('Saved browser draft')
    await page.reload()
    await expect(page.getByLabel('Posting text')).toHaveValue('Saved browser draft')
  })

  test('reviewing and locking a ready annual close', async ({ app, page }) => {
    let closed = false
    await page.route(`**/api/booking-records?year=${currentYear}`, route => fulfillJson(route, {
      ...openWorkspace,
      fiscalYear: { ...openWorkspace.fiscalYear, status: closed ? 'CLOSED' : 'OPEN' },
    }))
    await page.route(`**/api/fiscal-years/${currentYear}/close`, async route => {
      closed = true
      await fulfillJson(route, { data: { status: 'CLOSED' } })
    })
    page.once('dialog', dialog => dialog.accept())

    await app.open(`/annual-close/${currentYear}`)
    await expect(page.getByRole('heading', { name: 'Mathematically ready for approval' })).toBeVisible()
    await page.getByRole('button', { name: 'Review & lock' }).click()
    await expect(page.getByText('Locked', { exact: true })).toBeVisible()
  })
})
