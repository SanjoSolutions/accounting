import { expect, type Page } from '@playwright/test'

export class BookingBatchesPage {
  constructor(readonly page: Page, readonly year = 2026) {}

  async prepareBooking(description: string, receipt: Buffer) {
    await this.page.goto(`/bookings?year=${this.year}`)
    await this.page.locator('.document-actions input[type="file"]').setInputFiles({ name: `${description}.pdf`, mimeType: 'application/pdf', buffer: receipt })
    await expect(this.page.getByRole('button', { name: description, exact: true })).toHaveAttribute('aria-pressed', 'true')
    await this.page.getByLabel('Posting date', { exact: true }).fill(`${this.year}-08-10`)
    await this.page.getByLabel('Posting text', { exact: true }).fill(description)
    await this.page.getByRole('combobox', { name: 'Account row 1', exact: true }).click()
    await this.page.getByRole('option', { name: /^4930 ·/ }).click()
    await this.page.getByLabel('Debit row 1', { exact: true }).fill('10')
    await this.page.getByRole('combobox', { name: 'Account row 2', exact: true }).click()
    await this.page.getByRole('option', { name: /^1200 ·/ }).click()
    await this.page.getByLabel('Credit row 2', { exact: true }).fill('10')
  }

  async postNow() {
    await this.page.getByRole('radio', { name: 'Post now', exact: true }).check()
    await this.page.getByRole('button', { name: 'Post', exact: true }).click()
    await expect(this.page.getByRole('status')).toContainText('transaction has been posted')
  }

  async saveForReview() {
    await this.page.getByRole('radio', { name: 'Save to booking batches', exact: true }).check()
    await this.page.getByRole('button', { name: 'Save to booking batches', exact: true }).click()
    await expect(this.page.getByRole('status')).toContainText('has not been posted')
  }

  async reviewAndPost(description: string, revised: string) {
    await this.page.goto(`/booking-batches?year=${this.year}`)
    await this.page.getByRole('option').filter({ hasText: description }).click()
    await this.page.locator('#booking-batch-description').fill(revised)
    await this.page.getByRole('button', { name: 'Save draft', exact: true }).click()
    await expect(this.page.getByRole('status')).toContainText('saved')
    await this.page.getByRole('button', { name: 'Post to journal', exact: true }).click()
    await expect(this.page.getByRole('status')).toContainText('journal')
  }

  async journalContains(description: string, count: number) {
    await this.page.goto(`/journal?year=${this.year}`)
    await expect(this.page.getByRole('heading', { name: 'Posted entries', exact: true })).toBeVisible()
    await expect(this.page.locator('.journal-entry').filter({ hasText: description })).toHaveCount(count)
  }
}
