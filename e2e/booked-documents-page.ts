import { expect, type Page } from '@playwright/test'

export class BookedDocumentsPage {
  constructor(readonly page: Page) {}

  get picker() { return this.page.locator('.document-picker-panel') }
  get view() { return this.page.getByLabel('Document view') }

  async open() {
    await this.page.context().addCookies([{ name: 'NEXT_LOCALE', value: 'en', url: 'http://127.0.0.1:3223' }])
    await this.page.goto('/bookings?year=2026')
    await expect(this.view).toHaveValue('inbox')
  }

  async chooseBooked(name: string, previousDescription: string) {
    await expect(this.picker.getByRole('button', { name, exact: true })).toHaveCount(0)
    await this.view.selectOption('booked')
    await expect(this.picker.getByRole('link').filter({ hasText: previousDescription })).toBeVisible()
    await expect(this.picker.getByText('Posted', { exact: true })).toBeVisible()
    await this.picker.getByRole('button', { name, exact: true }).click()
    await expect(this.picker.getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'true')
  }

  async saveDraft(description: string) {
    await this.page.getByLabel('Posting date', { exact: true }).fill('2026-02-02')
    await this.page.getByLabel('Posting text', { exact: true }).fill(description)
    for (const [row, account] of [[1, /^4930 ·/], [2, /^1200 ·/]] as const) {
      await this.page.getByRole('combobox', { name: `Account row ${row}`, exact: true }).click()
      await this.page.getByRole('option', { name: account }).click()
    }
    await this.page.getByLabel('Debit row 1', { exact: true }).fill('10')
    await this.page.getByLabel('Credit row 2', { exact: true }).fill('10')
    const saved = this.page.waitForResponse(response => response.url().endsWith('/api/booking-records') && response.request().method() === 'POST')
    await this.page.getByRole('button', { name: 'Save to booking batches', exact: true }).click()
    const response = await saved
    expect(response.status(), await response.text()).toBe(201)
    return response.json()
  }

  async postDraft(description: string) {
    await this.page.goto('/booking-batches?year=2026')
    await this.page.getByRole('option').filter({ hasText: description }).click()
    const posted = this.page.waitForResponse(response => /\/api\/booking-batches\/[^/]+\/post$/.test(response.url()) && response.request().method() === 'POST')
    await this.page.getByRole('button', { name: 'Post to journal', exact: true }).click()
    const response = await posted
    expect(response.status(), await response.text()).toBe(200)
  }
}
