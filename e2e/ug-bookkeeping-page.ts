import { expect, type Page } from '@playwright/test'

export class UgBookkeepingPage {
  constructor(private readonly page: Page, private readonly year = 2026) {}

  async signUp(name: string, email: string, password: string) {
    await this.page.goto('/sign-up')
    await this.page.context().addCookies([{
      name: 'NEXT_LOCALE',
      value: 'en',
      url: new URL(this.page.url()).origin,
    }])
    await this.page.reload()
    await this.page.getByLabel('Name').fill(name)
    await this.page.getByLabel('Email').fill(email)
    await this.page.getByLabel('Password').fill(password)
    await this.page.getByRole('button', { name: 'Create account', exact: true }).click()
    await expect(this.page).toHaveURL('/')
  }

  async uploadReceipt(pdf: Buffer) {
    await this.page.goto('/bookings')
    await this.page.getByLabel('Fiscal year').fill(String(this.year))
    await expect(this.page.getByRole('combobox', { name: 'Account row 1' })).toBeEnabled()
    await this.page.locator('.document-actions input[type="file"]').setInputFiles({
      name: 'ug-bookkeeping-receipt.pdf',
      mimeType: 'application/pdf',
      buffer: pdf,
    })
    await expect(this.page.getByRole('button', { name: 'ug-bookkeeping-receipt' })).toHaveAttribute('aria-pressed', 'true')
  }

  async proveUnbalancedPostingIsBlocked() {
    await this.page.getByLabel('Posting date').fill(`${this.year}-02-12`)
    await this.page.getByLabel('Posting text').fill('Office supplies with retained receipt')
    await this.selectAccount(1, /^4930 ·/)
    await this.page.getByLabel('Debit row 1').fill('119')
    await this.selectAccount(2, /^1200 ·/)
    await this.page.getByLabel('Credit row 2').fill('118')

    await expect(this.page.getByText('Difference').locator('..')).toContainText('1,00')
    await expect(this.page.getByRole('button', { name: 'Post', exact: true })).toBeDisabled()
  }

  async balanceAndPost() {
    await this.page.getByLabel('Credit row 2').fill('119')
    await expect(this.page.getByText('Difference').locator('..')).toContainText('0,00')
    await this.page.getByRole('button', { name: 'Post', exact: true }).click()
    await expect(this.page.getByRole('status')).toContainText('transaction has been posted')
  }

  async expectPersistedJournalEntry() {
    await this.page.goto(`/journal?year=${this.year}`)
    await expect(this.page.getByRole('heading', { name: 'Posted entries' })).toBeVisible()
    const entry = this.page.getByText('Office supplies with retained receipt').locator('xpath=ancestor::article[1]')
    await expect(entry).toContainText('4930 ·')
    await expect(entry).toContainText('1200 ·')
    await expect(entry.getByRole('link', { name: 'ug-bookkeeping-receipt.pdf' })).toBeVisible()
    await this.page.reload()
    await expect(this.page.getByText('Office supplies with retained receipt')).toBeVisible()
  }

  async expectPersistedStatements() {
    await this.page.goto('/')
    await this.page.getByLabel('Fiscal year').fill(String(this.year))
    const metrics = this.page.getByRole('region', { name: 'Metrics' })
    await expect(metrics).toContainText('119,00')
    await this.page.reload()
    await expect(this.page.getByRole('region', { name: 'Metrics' })).toContainText('119,00')
  }

  private async selectAccount(row: number, account: RegExp) {
    await this.page.getByRole('combobox', { name: `Account row ${row}` }).click()
    await this.page.getByRole('option', { name: account }).click()
  }
}
