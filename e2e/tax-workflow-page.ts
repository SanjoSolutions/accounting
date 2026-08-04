import { expect, type Page } from '@playwright/test'

export class TaxWorkflowPage {
  constructor(private readonly page: Page, private readonly year = 2026) {}

  async postStandardRatedSale(pdf: Buffer, options: { fileName?: string; postingDate?: string; postingText?: string } = {}) {
    await this.page.goto('/bookings')
    await this.page.getByLabel('Fiscal year').fill(String(this.year))
    await expect(this.page.getByRole('combobox', { name: 'Account row 1' })).toBeEnabled()
    await this.page.locator('.document-actions input[type="file"]').setInputFiles({
      name: options.fileName ?? 'taxable-sale-evidence.pdf',
      mimeType: 'application/pdf',
      buffer: pdf,
    })
    await expect(this.page.getByRole('button', { name: (options.fileName ?? 'taxable-sale-evidence.pdf').replace(/\.pdf$/i, '') })).toHaveAttribute('aria-pressed', 'true')
    await this.page.getByLabel('Posting date').fill(options.postingDate ?? `${this.year}-01-15`)
    await this.page.getByLabel('Posting text').fill(options.postingText ?? 'Taxable domestic sale')
    await this.selectAccount(1, '1200 · Bank')
    await this.page.getByLabel('Debit row 1').fill('119')
    await this.selectAccount(2, '8400 · Erlöse 19 % USt')
    await this.page.getByLabel('Credit row 2').fill('100')
    await this.page.getByLabel('VAT row 2').selectOption('DE_STANDARD_SALE_NET')
    await this.page.getByRole('button', { name: 'Add split row' }).click()
    await this.selectAccount(3, '1776 · Umsatzsteuer 19 %')
    await this.page.getByLabel('Credit row 3').fill('19')
    await this.page.getByRole('button', { name: 'Post', exact: true }).click()
    await expect(this.page.getByRole('status')).toContainText('transaction has been posted')
  }

  async prepare(kind: 'USTVA' | 'UST_ANNUAL' | 'KST' | 'GEWST') {
    await this.page.goto(`/tax/${this.year}`)
    await expect(this.page.getByRole('heading', { name: `Tax filings ${this.year}` })).toBeVisible()
    if (kind !== 'USTVA') await this.page.getByLabel('Form').selectOption(kind)
    await this.page.getByRole('button', { name: 'Validate officially' }).click()
    await expect(this.page.getByText('The official gateway validated the dataset.', { exact: true })).toBeVisible()
  }

  async expectPreparedSourceChangeBlocked(message: RegExp) {
    await this.page.getByLabel('I explicitly approve this binding transmission.').check()
    const rejectedResponse = this.page.waitForResponse(response => response.url().endsWith('/api/tax/workflows') && response.request().method() === 'POST')
    await this.page.getByRole('button', { name: 'Submit binding' }).click()
    const response = await rejectedResponse
    expect(response.status()).toBe(400)
    expect(await response.text()).toMatch(message)
    await expect(this.page.getByText('The declaration was transmitted and archived.', { exact: true })).toHaveCount(0)
  }

  async saveEvidenceBackedAdjustment(kind: 'KST' | 'GEWST', evidenceId: string) {
    await this.page.goto(`/tax/${this.year}`)
    await this.page.getByLabel('Form').selectOption(kind)
    await this.page.getByText('Evidence-backed tax adjustment', { exact: true }).click()
    await this.page.getByLabel('Layer').selectOption(kind === 'KST' ? 'income-tax' : 'trade-tax')
    await this.page.getByLabel('Amount (cents; negative for deduction)').fill('100')
    await this.page.getByLabel('Reason').fill('E2E evidenced non-deductible amount')
    await this.page.getByLabel('Evidence document IDs (comma-separated)').fill(evidenceId)
    await this.page.getByRole('button', { name: 'Save adjustment' }).click()
    await expect(this.page.getByText('Evidence-backed tax adjustment saved. Prepare the declaration again.', { exact: true })).toBeVisible()
  }

  async submit(kind: 'USTVA' | 'UST_ANNUAL', receipt: string) {
    if (kind === 'USTVA') {
      await this.page.goto(`/tax/${this.year}`)
      await expect(this.page.getByLabel('Form')).toHaveValue('USTVA')
      await expect(this.page.getByLabel('Period')).toHaveValue(`${this.year}-01`)
    }
    await this.prepare(kind)
    await expect(this.page.getByLabel('Official fields (integer cents)')).toContainText('"ZAHLLAST": 1900')
    await this.page.getByLabel('I explicitly approve this binding transmission.').check()
    await this.page.getByRole('button', { name: 'Submit binding' }).click()
    await expect(this.page.getByText('The declaration was transmitted and archived.', { exact: true })).toBeVisible()
    await expect(this.page.getByRole('cell', { name: receipt })).toBeVisible()
    await this.page.reload()
    await expect(this.page.getByRole('cell', { name: receipt })).toBeVisible()
  }

  private async selectAccount(row: number, account: string) {
    await this.page.getByRole('combobox', { name: `Account row ${row}` }).click()
    await this.page.getByRole('option', { name: account, exact: true }).click()
  }
}
