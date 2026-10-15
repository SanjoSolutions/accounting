import { readFileSync } from 'node:fs'
import { test, expect } from '@playwright/test'
import { BookingBatchesPage } from './booking-batches-page'

const receipt = readFileSync(new URL('./fixtures/invoice.pdf', import.meta.url))

test('Given a manual booking, when choosing either workflow, then only explicitly posted entries reach the journal', async ({ page }, testInfo) => {
  const bookings = new BookingBatchesPage(page)
  await bookings.prepareBooking('Immediate synthetic receipt', receipt)
  await expect(page.getByRole('radio', { name: 'Post now', exact: true })).toHaveAccessibleDescription(/Posts to the journal immediately/)
  await page.screenshot({ path: testInfo.outputPath('booking-choice-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: testInfo.outputPath('booking-choice-mobile.png'), fullPage: true })
  await page.setViewportSize({ width: 1280, height: 900 })
  await bookings.postNow()
  await bookings.journalContains('Immediate synthetic receipt', 1)

  await bookings.prepareBooking('Draft synthetic receipt', receipt)
  await page.getByRole('radio', { name: 'Save to booking batches', exact: true }).check()
  await expect(page.getByRole('radio', { name: 'Save to booking batches', exact: true })).toHaveAccessibleDescription(/editable draft for later review/)
  await bookings.saveForReview()
  await bookings.journalContains('Draft synthetic receipt', 0)
  await bookings.reviewAndPost('Draft synthetic receipt', 'Reviewed synthetic receipt')
  await bookings.journalContains('Reviewed synthetic receipt', 1)
  await page.reload()
  await expect(page.locator('.journal-entry').filter({ hasText: 'Reviewed synthetic receipt' })).toHaveCount(1)
})

test('Given a committed posting whose response is lost, when reloaded and retried, then the same entry is confirmed exactly once', async ({ page }, testInfo) => {
  const bookings = new BookingBatchesPage(page)
  await bookings.prepareBooking('Recoverable synthetic receipt', receipt)
  let dropped = false
  await page.route('**/api/booking-batches/*/post', async route => {
    if (dropped) return route.continue()
    dropped = true
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    await route.abort('failed')
  })
  await page.getByRole('button', { name: 'Post', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Retry posting', exact: true })).toBeEnabled()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Complete saved booking' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('posting-recovery-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: testInfo.outputPath('posting-recovery-mobile.png'), fullPage: true })
  await page.getByRole('button', { name: 'Retry posting', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('transaction has been posted')
  await bookings.journalContains('Recoverable synthetic receipt', 1)
})

test('Given unavailable recovery storage, when posting immediately, then the saved draft remains unposted for review', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('accounting.bookings.pending-post.')) throw new DOMException('Storage unavailable', 'QuotaExceededError')
      return original.call(this, key, value)
    }
  })
  const bookings = new BookingBatchesPage(page)
  await bookings.prepareBooking('Storage failure synthetic receipt', receipt)
  await page.getByRole('button', { name: 'Post', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Posting has not started')
  await page.screenshot({ path: testInfo.outputPath('storage-recovery-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: testInfo.outputPath('storage-recovery-mobile.png'), fullPage: true })
  await page.getByRole('link', { name: 'Review booking batches', exact: true }).click()
  await expect(page.getByRole('option').filter({ hasText: 'Storage failure synthetic receipt' })).toBeVisible()
  await bookings.journalContains('Storage failure synthetic receipt', 0)
})
