import { expect, type Page } from '@playwright/test'

export class TaxReviewPage {
  constructor(readonly page: Page) {}

  async initializeLedger() {
    await this.page.goto('/bookings?year=2026')
    await expect(this.page.getByRole('spinbutton', { name: 'Fiscal year', exact: true })).toHaveValue('2026')
  }

  async open() {
    await this.page.goto('/tax/2026')
    await expect(this.page.getByRole('heading', { name: 'Tax filings 2026' })).toBeVisible()
  }

  async prepare(kind: 'USTVA' | 'UST_ANNUAL') {
    await this.page.getByLabel('Form', { exact: true }).selectOption(kind)
    await this.page.getByRole('button', { name: 'Prepare for review', exact: true }).click()
    await expect(this.page.getByRole('heading', { name: 'Review before ELSTER', exact: true })).toBeVisible()
    await expect(this.page.getByRole('status').filter({ hasText: 'Prepared locally for review.' })).toBeVisible()
    await this.expectSubmissionDisabled()
  }

  async expectSubmissionDisabled() {
    await expect(this.page.getByLabel('I explicitly approve this binding transmission.')).toBeDisabled()
    await expect(this.page.getByRole('button', { name: 'Submit binding', exact: true })).toBeDisabled()
  }

  async download() {
    const promise = this.page.waitForEvent('download')
    await this.page.getByRole('button', { name: 'Download review file', exact: true }).click()
    return promise
  }

  async expectUnavailableValidationKeepsSubmissionDisabled() {
    const response = this.page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/tax/workflows')
    await this.page.getByRole('button', { name: 'Validate officially', exact: true }).click()
    expect((await response).status()).toBe(503)
    await this.expectSubmissionDisabled()
  }
}
