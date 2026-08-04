import { expect, type Page } from '@playwright/test'

export class FixedAssetsPage {
  constructor(private readonly page: Page) {}

  async signUp(name: string, email: string) {
    await this.page.goto('/sign-up'); await this.page.context().addCookies([{ name: 'NEXT_LOCALE', value: 'en', url: new URL(this.page.url()).origin }]); await this.page.reload()
    await this.page.getByLabel('Name').fill(name); await this.page.getByLabel('Email').fill(email); await this.page.getByLabel('Password').fill('playwright-password-2026'); await this.page.getByRole('button', { name: 'Create account', exact: true }).click(); await expect(this.page).toHaveURL('/')
  }

  async uploadEvidence(pdf: Buffer) {
    await this.page.goto('/bookings'); await expect(this.page.getByRole('combobox', { name: 'Account row 1' })).toBeEnabled()
    await this.page.locator('.document-actions input[type="file"]').setInputFiles({ name: 'laptop-acquisition.pdf', mimeType: 'application/pdf', buffer: pdf })
    await expect(this.page.getByRole('button', { name: 'laptop-acquisition' })).toHaveAttribute('aria-pressed', 'true')
    await this.page.getByLabel('Posting date').fill('2026-01-10'); await this.page.getByLabel('Posting text').fill('Capitalized laptop acquisition')
    await this.selectAccount(1, /^300 ·/); await this.page.getByLabel('Debit row 1').fill('120')
    await this.selectAccount(2, /^1600 ·/); await this.page.getByLabel('Credit row 2').fill('120')
    await this.page.getByRole('button', { name: 'Post', exact: true }).click(); await expect(this.page.getByRole('status')).toContainText('transaction has been posted')
  }

  async createSaleCustomer() {
    await this.page.goto('/receivables'); await expect(this.page.getByRole('heading', { name: 'Customers & open items' })).toBeVisible()
    await this.page.getByLabel('Customer / supplier number').fill('K-SALE-001'); await this.page.getByLabel('Business partner name').fill('Berlin Equipment Buyer GmbH'); await this.page.getByLabel('Payment term in days').fill('14')
    await this.page.getByRole('button', { name: 'Create business partner' }).click(); await expect(this.page.getByRole('status')).toContainText('business partner was created')
  }

  async registerAndPost() {
    await this.page.goto('/fixed-assets'); await expect(this.page.getByRole('heading', { name: 'Fixed-asset register' })).toBeVisible()
    await this.page.getByLabel('Asset description').fill('Development laptop')
    await this.page.getByLabel('Acquisition cost (EUR)').fill('120.00')
    await this.page.getByLabel('Acquisition date').fill('2026-01-10'); await this.page.getByLabel('Available for use').fill('2026-01-10')
    await this.page.getByLabel('Useful life (months)').fill('3'); await this.page.getByLabel('Location').fill('Berlin office')
    await expect(this.page.getByLabel('Fixed-asset account')).toContainText('0300')
    await expect(this.page.getByLabel('Depreciation expense account')).toContainText('4830')
    await this.page.getByLabel('Acquisition evidence').selectOption({ label: 'laptop-acquisition.pdf' })
    const acquisitionDebit = this.page.getByLabel('Posted acquisition debit')
    const acquisitionValue = await acquisitionDebit.locator('option').evaluateAll(options => options.find(option => /2026-01-10.*0300.*120/.test(option.textContent ?? ''))?.getAttribute('value'))
    expect(acquisitionValue).toBeTruthy(); await acquisitionDebit.selectOption(acquisitionValue!)
    await this.page.getByRole('button', { name: 'Register fixed asset' }).click(); await expect(this.page.getByRole('status')).toContainText('exact-cent schedule')
    const asset = this.page.locator('section.card').filter({ hasText: 'Development laptop' }); const january = asset.getByRole('row').filter({ hasText: '2026-01' })
    await expect(january).toContainText('40,00'); await expect(january).toContainText('80,00'); await january.getByRole('button', { name: 'Post period' }).click()
    await expect(this.page.getByRole('status')).toContainText('Depreciation 2026-01')
  }

  async uploadRetirementEvidence(pdf: Buffer) {
    await this.page.goto('/bookings')
    await this.page.locator('.document-actions input[type="file"]').setInputFiles({ name: 'retirement-certificate.pdf', mimeType: 'application/pdf', buffer: pdf })
    await expect(this.page.getByRole('button', { name: 'retirement-certificate' })).toHaveAttribute('aria-pressed', 'true')
  }

  async uploadSaleEvidence(pdf: Buffer) {
    await this.page.goto('/bookings')
    await this.page.locator('.document-actions input[type="file"]').setInputFiles({ name: 'asset-sale-contract.pdf', mimeType: 'application/pdf', buffer: pdf })
    await expect(this.page.getByRole('button', { name: 'asset-sale-contract' })).toHaveAttribute('aria-pressed', 'true')
  }

  async postFullRetirement() {
    await this.page.goto('/fixed-assets')
    const asset = this.page.locator('section.card').filter({ hasText: 'Development laptop' })
    await asset.getByLabel('Full-retirement date').fill('2026-02-15')
    await asset.getByLabel('Retirement evidence').selectOption({ label: 'retirement-certificate.pdf' })
    await expect(asset.getByLabel('Retirement-loss account')).toContainText('2310')
    await asset.getByLabel('Retirement approval reason').fill('Irreparably destroyed; management approved scrapping')
    await asset.getByRole('button', { name: 'Post full retirement' }).click()
    await expect(this.page.locator('[role="status"].alert-success')).toContainText(/80[,.]00.*carrying value was derecognized/)
    await this.page.reload()
    await expect(this.page.locator('section.card').filter({ hasText: 'Development laptop' }).getByRole('status')).toContainText('Fully retired on 2026-02-15')
  }

  async postFullDomesticSale() {
    await this.page.goto('/fixed-assets')
    const asset = this.page.locator('section.card').filter({ hasText: 'Development laptop' })
    await asset.getByLabel('Full-sale date').fill('2026-02-15')
    await asset.getByLabel('Sale evidence').selectOption({ label: 'asset-sale-contract.pdf' })
    const customer = asset.getByLabel('Customer'); const customerValue = await customer.locator('option').evaluateAll(options => options.find(option => /K-SALE-001.*Berlin Equipment Buyer GmbH/.test(option.textContent ?? ''))?.getAttribute('value')); expect(customerValue).toBeTruthy(); await customer.selectOption(customerValue!)
    await asset.getByLabel('Sale invoice number').fill('ASSET-SALE-2026-001')
    await asset.getByLabel('Net sale proceeds (EUR)').fill('100.00')
    await expect(asset.getByLabel('DATEV sale-proceeds account')).toHaveValue(/8820/)
    await expect(asset.getByLabel('DATEV carrying-value account')).toHaveValue(/2315/)
    await expect(asset.getByLabel('Receivable account')).toHaveValue(/1400/)
    await expect(asset.getByLabel('Output-VAT account')).toHaveValue(/1776/)
    await expect(asset.getByRole('note')).toContainText(/carrying value.*80[,.]00.*net proceeds.*100[,.]00.*output VAT.*19[,.]00.*gross receivable.*119[,.]00.*book gain.*20[,.]00/i)
    await asset.getByLabel('Sale approval reason').fill('Management approved evidenced domestic equipment sale')
    await asset.getByRole('button', { name: 'Post full sale' }).click()
    await expect(this.page.locator('[role="status"].alert-success')).toContainText(/119[,.]00.*20[,.]00.*book gain/i)
    await this.page.reload(); await expect(this.page.locator('section.card').filter({ hasText: 'Development laptop' }).getByRole('status')).toContainText(/Sold in full on 2026-02-15.*100[,.]00.*19[,.]00.*20[,.]00/)
  }

  async proveSalePersistenceAndJournal() {
    await this.page.reload(); const asset = this.page.locator('section.card').filter({ hasText: 'Development laptop' }); await expect(asset.getByRole('button', { name: 'Post period' })).toHaveCount(0); await expect(asset.getByRole('button', { name: 'Reverse' })).toHaveCount(0); await expect(asset.getByRole('button', { name: 'Post full sale' })).toHaveCount(0)
    await this.page.goto('/journal?year=2026'); const sale = this.page.locator('.journal-entry').filter({ hasText: 'Full asset sale: Development laptop' }); await expect(sale).toHaveCount(1)
    for (const proof of ['1400', 'Soll 119,00', '2315', 'Soll 80,00', '8820', 'Haben 100,00', '1776', 'Haben 19,00', '300', 'Haben 80,00']) await expect(sale).toContainText(proof)
    await expect(sale.getByRole('link', { name: 'asset-sale-contract.pdf' })).toBeVisible(); await this.page.reload(); await expect(this.page.locator('.journal-entry').filter({ hasText: 'Full asset sale: Development laptop' })).toHaveCount(1)
    await this.page.goto('/receivables'); const openItem = this.page.getByRole('row').filter({ hasText: 'ASSET-SALE-2026-001' }); await expect(openItem).toContainText('Berlin Equipment Buyer GmbH'); await expect(openItem).toContainText(/119[,.]00/); await expect(openItem).toContainText(/open/i)
  }

  async provePersistenceAndJournal() {
    await this.page.reload(); const january = this.page.locator('section.card').filter({ hasText: 'Development laptop' }).getByRole('row').filter({ hasText: '2026-01' }); await expect(january).toContainText('Posted'); await expect(january.getByRole('button', { name: 'Reverse' })).toHaveCount(0)
    await this.page.goto('/journal?year=2026'); const journal = this.page.locator('.journal-entry').filter({ hasText: 'Monthly depreciation: Development laptop' })
    const acquisition = this.page.locator('.journal-entry').filter({ hasText: 'Capitalized laptop acquisition' }); await expect(acquisition).toHaveCount(1); await expect(acquisition).toContainText('300'); await expect(acquisition.getByRole('link', { name: 'laptop-acquisition.pdf' })).toBeVisible()
    await expect(journal).toContainText('4830'); await expect(journal).toContainText('Soll 40,00'); await expect(journal).toContainText('300'); await expect(journal).toContainText('Haben 40,00'); await expect(journal.getByRole('link', { name: 'laptop-acquisition.pdf' })).toBeVisible()
    const retirement = this.page.locator('.journal-entry').filter({ hasText: 'Full retirement: Development laptop' }); await expect(retirement).toContainText('2310'); await expect(retirement).toContainText('Soll 80,00'); await expect(retirement).toContainText('300'); await expect(retirement).toContainText('Haben 80,00'); await expect(retirement.getByRole('link', { name: 'retirement-certificate.pdf' })).toBeVisible()
    await this.page.reload(); await expect(this.page.locator('.journal-entry').filter({ hasText: 'Monthly depreciation: Development laptop' })).toBeVisible()
  }

  private async selectAccount(row: number, account: RegExp) { await this.page.getByRole('combobox', { name: `Account row ${row}` }).click(); await this.page.getByRole('option', { name: account }).click() }
}
