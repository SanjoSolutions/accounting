import { expect, type Page, type Route } from '@playwright/test'

export class InvoiceNumberingPage {
  constructor(private readonly page: Page) {}
  get section() { return this.page.getByRole('region', { name: 'Invoice numbering', exact: true }) }

  async open() {
    await this.page.goto('/invoices')
    await expect(this.section).toBeVisible()
  }

  async fill(year: number, firstUnused: number, imported: string[]) {
    await this.section.getByLabel('Invoice year', { exact: true }).fill(String(year))
    await this.section.getByLabel('First unused invoice number', { exact: true }).fill(String(firstUnused))
    await this.section.getByLabel('Imported outgoing invoice numbers', { exact: true }).fill(imported.join('\n'))
  }

  async confirmAndSave(progressScreenshot?: string) {
    let releaseResponse = () => {}
    const responseReleased = new Promise<void>(resolve => { releaseResponse = resolve })
    const holdResponse = async (route: Route) => {
      if (route.request().method() !== 'POST') return route.continue()
      // Exercise the real mutation, holding only its response to verify feedback.
      const response = await route.fetch()
      await responseReleased
      await route.fulfill({ response })
    }
    if (progressScreenshot) await this.page.route('**/api/tax/e-invoices', holdResponse)
    await this.section.getByLabel('I confirm this is the first unused invoice number', { exact: true }).check()
    const response = this.page.waitForResponse(response => response.url().endsWith('/api/tax/e-invoices') && response.request().method() === 'POST')
    try {
      await this.section.getByRole('button', { name: 'Initialize numbering', exact: true }).click()
      if (progressScreenshot) {
        await expect(this.section.getByRole('button', { name: 'Initializing…', exact: true })).toBeDisabled()
        await expect(this.section.getByRole('status')).toHaveText('Initializing…')
        await expect(this.section.locator('form')).toHaveAttribute('aria-busy', 'true')
        await this.section.screenshot({ path: progressScreenshot })
      }
    } finally { releaseResponse() }
    expect((await response).status()).toBe(201)
    if (progressScreenshot) await this.page.unroute('**/api/tax/e-invoices', holdResponse)
    await expect(this.section.getByRole('status')).toHaveText('Invoice numbering is ready.')
  }

  async proveConfirmationTracksInputs() {
    const confirmation = this.section.getByLabel('I confirm this is the first unused invoice number', { exact: true })
    await confirmation.check()
    await this.section.getByLabel('First unused invoice number', { exact: true }).fill('43')
    await expect(confirmation).not.toBeChecked()
    await expect(this.section.getByRole('button', { name: 'Initialize numbering', exact: true })).toBeDisabled()
    await this.section.getByLabel('First unused invoice number', { exact: true }).fill('42')
  }

  async expectReconciled(year: number, next: number) {
    await expect(this.section.getByRole('listitem').filter({ hasText: `${year}: next number ${next}.` })).toContainText('Reconciled')
  }
}
