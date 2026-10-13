import { expect, type Page } from '@playwright/test'
import { StructuredInvoicesPage } from './structured-invoices-page'

export class InvoiceRetryPage extends StructuredInvoicesPage {
  constructor(private readonly retryPage: Page) { super(retryPage) }

  async prepareIssuer() {
    const response = await this.retryPage.request.put('/api/settings', { data: {
      chartOfAccounts: 'SKR03',
      invoiceIssuer: { name: 'Retry Test UG', streetAndHouseNumber: 'Teststraße 1', zipCode: '10115', city: 'Berlin', country: 'DE', contactName: 'Test accounts', contactTelephone: '+49 30 123456', contactEmail: 'billing@example.test' },
      companyProfile: { companyName: 'Retry Test UG', legalForm: 'UG', registeredAddress: { streetAndHouseNumber: 'Teststraße 1', zipCode: '10115', city: 'Berlin', country: 'DE' }, registerCourt: 'Berlin', registerNumber: 'HRB 123456', taxNumber: '12/345/67890', vatId: 'DE123456789', taxOffice: 'Berlin', vatRegime: 'STANDARD', vatFilingFrequency: 'MONTHLY', activity: 'Software', sizeClass: 'MICRO', chart: 'SKR03', elections: [] },
      companyProfileEffectiveFrom: new Date().toISOString().slice(0, 10), changeReason: 'Synthetic invoice retry fixture',
    } })
    expect(await response.json()).toMatchObject({ success: true })
    expect((await this.retryPage.request.get('/api/booking-records?year=2026')).ok()).toBe(true)
  }

  async prepareCredit(net = '20.00') {
    await this.retryPage.getByRole('row', { name: /2026-000001/ }).getByRole('button', { name: 'Issue credit note', exact: true }).click()
    await this.retryPage.getByLabel('Issue date').last().fill('2026-08-05')
    await this.retryPage.getByLabel('Credit reason').fill('Synthetic partial service reduction')
    await this.retryPage.getByLabel('Credit net amount (EUR)').fill(net)
  }

  async submitCredit() { await this.retryPage.getByRole('button', { name: 'Issue and post credit note', exact: true }).click() }

  async reviseRejectedCredit(net: string) {
    await expect(this.retryPage.getByRole('heading', { name: 'Confirm pending invoice request' })).toHaveCount(0)
    await expect(this.retryPage.getByLabel('Credit net amount (EUR)')).toBeEnabled()
    await this.retryPage.getByLabel('Credit net amount (EUR)').fill(net)
  }

  async expectCreditConfirmed() {
    await expect(this.retryPage.getByRole('status')).toContainText('2026-000002')
    await expect(this.retryPage.getByRole('heading', { name: 'Confirm pending invoice request' })).toHaveCount(0)
    await expect(this.retryPage.getByRole('button', { name: 'Issue credit note', exact: true })).toBeEnabled()
    await expect(this.retryPage.getByRole('row', { name: /2026-000002.*credit-note/ })).toHaveCount(1)
  }

  async expectPending() {
    await expect(this.retryPage.getByRole('heading', { name: 'Confirm pending invoice request' })).toBeVisible()
    await expect(this.retryPage.getByRole('button', { name: 'Retry saved request' })).toBeEnabled()
    await expect(this.retryPage.getByRole('button', { name: 'Issue invoice', exact: true })).toBeDisabled()
    await expect(this.retryPage.getByRole('button', { name: 'Issue credit note', exact: true })).toBeDisabled()
  }

  async expectCreditFactsLocked() {
    for (const label of ['Credit reason', 'Credit net amount (EUR)']) await expect(this.retryPage.getByLabel(label)).toBeDisabled()
    await expect(this.retryPage.locator('#credit-date')).toBeDisabled()
    await expect(this.retryPage.locator('#credit-rate')).toBeDisabled()
  }

  async retryAndExpectConfirmed() {
    await this.retryPage.getByRole('button', { name: 'Retry saved request' }).click()
    await this.expectCreditConfirmed()
  }
}
