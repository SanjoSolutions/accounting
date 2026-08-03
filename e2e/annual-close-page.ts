import { expect, type Page } from '@playwright/test'

export class AnnualClosePage {
  constructor(private readonly page: Page) {}

  async createExpiredShortFiscalYear2026() {
    await this.page.goto('/compliance')
    await expect(this.page.getByRole('heading', { name: 'Fiscal periods' })).toBeVisible()
    const section = this.page.getByRole('heading', { name: 'Fiscal periods' }).locator('xpath=ancestor::section[1]')
    await section.getByLabel('Reference year').fill('2026')
    await section.getByLabel('Label').fill('Short fiscal year 2026')
    await section.getByLabel('Starts').fill('2026-01-01')
    await section.getByLabel('Ends').fill('2026-06-30')
    await section.getByLabel('Reason').fill('Playwright annual-close acceptance test')
    await section.getByRole('button', { name: 'Create stable period' }).click()
    await expect(this.page.getByRole('status')).toContainText('fiscal period was created')
    await expect(section).toContainText('2026-01-01–2026-06-30 · OPEN')
  }

  async postRevenueWithEvidence(pdf: Buffer) {
    await this.page.goto('/bookings')
    await this.page.getByLabel('Fiscal year').fill('2026')
    await expect(this.page.getByRole('combobox', { name: 'Account row 1' })).toBeEnabled()

    await this.page.locator('.document-actions input[type="file"]').setInputFiles({
      name: 'annual-close-evidence.pdf',
      mimeType: 'application/pdf',
      buffer: pdf,
    })
    await expect(this.page.getByRole('button', { name: 'annual-close-evidence' })).toHaveAttribute('aria-pressed', 'true')

    await this.page.getByLabel('Posting date').fill('2026-01-15')
    await this.page.getByLabel('Posting text').fill('Revenue for annual close')
    await this.selectAccount(1, '1200 · Bank')
    await this.page.getByLabel('Debit row 1').fill('119')
    await this.selectAccount(2, '8400 · Erlöse 19 % USt')
    await this.page.getByLabel('Credit row 2').fill('119')
    await this.page.getByRole('button', { name: 'Post', exact: true }).click()
    await expect(this.page.getByRole('status')).toContainText('transaction has been posted')
  }

  async expectHgbCloseBlocked2026() {
    await this.page.goto('/annual-close/2026')
    await expect(this.page.getByText('A current HGB close run with READY_TO_LOCK status is required.')).toBeVisible()
    await this.expectStatement('Assets', '119,00')
    await this.expectStatement('Revenue', '119,00')
    await this.expectStatement('Annual result', '119,00')

    await expect(this.page.getByRole('button', { name: 'Review & lock' })).toBeDisabled()
  }

  async lockReadyFiscalYear(year: number) {
    await this.page.goto(`/annual-close/${year}`)
    await expect(this.page.getByText('READY_TO_LOCK', { exact: false })).toBeVisible()
    const button = this.page.getByRole('button', { name: 'Review & lock' })
    await expect(button).toBeEnabled()
    this.page.once('dialog', dialog => dialog.accept())
    await button.click()
    await expect(this.page.locator('.page-heading .status')).toContainText('Locked')
  }

  private async selectAccount(row: number, account: string) {
    await this.page.getByRole('combobox', { name: `Account row ${row}` }).press('Enter')
    await this.page.getByRole('option', { name: account, exact: true }).click()
  }

  private async expectStatement(label: string, value: string) {
    const statement = this.page.locator('.statement-preview dl > div').filter({
      has: this.page.locator('dt', { hasText: label }),
    })
    await expect(statement).toContainText(value)
  }
}
