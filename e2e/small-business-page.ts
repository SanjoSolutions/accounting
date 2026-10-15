import { expect, type Page } from '@playwright/test'
import { StructuredInvoicesPage } from './structured-invoices-page'

export class SmallBusinessPage {
  constructor(private readonly page: Page) {}

  async configure() {
    await new StructuredInvoicesPage(this.page).signUp('Synthetic Kleinunternehmer', `small-${Date.now()}@example.test`, 'synthetic-browser-password-28')
    const response = await this.page.request.put('/api/settings', { data: {
      invoiceIssuer: { name: 'Synthetic Kleinunternehmer UG', streetAndHouseNumber: 'Teststraße 1', zipCode: '10115', city: 'Berlin', country: 'DE', contactName: 'Accounts', contactTelephone: '+49 30 123456', contactEmail: 'seller@example.test' },
      companyProfile: { companyName: 'Synthetic Kleinunternehmer UG', legalForm: 'UG', taxNumber: '12/345/67890', taxOffice: 'Berlin', vatRegime: 'SMALL_BUSINESS', vatFilingFrequency: 'ANNUAL', activity: 'Consulting', sizeClass: 'MICRO', chart: 'SKR03', elections: [] },
      companyProfileEffectiveFrom: '2026-01-01', confirmProfilePreviouslyValid: true, changeReason: 'Synthetic confirmed eligibility for isolated browser verification',
    } })
    expect(await response.json()).toMatchObject({ success: true })
    expect((await this.page.request.get('/api/booking-records?year=2026')).ok()).toBe(true)
    await this.page.goto('/compliance')
    await expect(this.page.getByText(/Turnover is not monitored automatically/)).toBeVisible()
    await this.page.screenshot({ path: '.playwright/issue-28-profile-desktop.png', fullPage: true })
    // The shared numbering page model is independent of tax treatment.
    await this.page.goto('/invoices')
    await this.page.getByLabel('Invoice year').fill('2026')
    await this.page.getByLabel('First unused invoice number', { exact: true }).fill('1')
    await this.page.getByLabel('I confirm this is the first unused invoice number', { exact: true }).check()
    await this.page.getByRole('button', { name: 'Initialize numbering' }).click()
    await expect(this.page.getByRole('status')).toContainText('numbering is ready')
  }

  async issueAndCredit() {
    const p = this.page
    await p.getByLabel('Issue date').fill('2026-10-15'); await p.getByLabel('Supply date').fill('2026-10-15')
    for (const [label, value] of [['Buyer reference / Leitweg-ID', 'Order 28'], ['Buyer electronic address', 'buyer@example.test'], ['Buyer name', 'Synthetic buyer'], ['Buyer street and house number', 'Test 2'], ['Buyer postal code', '10115'], ['Buyer city', 'Berlin'], ['Buyer country', 'DE'], ['Description row 1', 'Consulting'], ['Quantity row 1', '1'], ['Unit row 1', 'C62'], ['Net amount row 1', '100.00'], ['Payment terms', '14 days'], ['IBAN', 'DE89370400440532013000']]) await p.getByLabel(label, { exact: true }).fill(value)
    await p.getByLabel('Electronic address scheme').selectOption('EM')
    await p.getByLabel('VAT rate row 1').selectOption('0')
    await p.screenshot({ path: '.playwright/issue-28-invoice-desktop.png', fullPage: true })
    await p.setViewportSize({ width: 390, height: 844 })
    await p.screenshot({ path: '.playwright/issue-28-invoice-mobile.png', fullPage: true })
    await p.setViewportSize({ width: 1280, height: 900 })
    await p.getByRole('button', { name: 'Issue invoice', exact: true }).click()
    await expect(p.getByRole('status')).toContainText('2026-000001')
    const listed = await (await p.request.get('/api/tax/e-invoices')).json()
    const issued = listed.data.find((item: { invoiceNumber: string }) => item.invoiceNumber === '2026-000001')
    const xml = await (await p.request.get(`/api/documents/${issued.documentId}/file`)).text()
    expect(xml).toContain('Steuerbefreiung für Kleinunternehmer gemäß § 19 UStG.')
    expect(xml).toContain('<cbc:TaxAmount currencyID="EUR">0.00</cbc:TaxAmount>')
    const rendering = await (await p.request.get(`/api/tax/e-invoices/${issued.id}/rendering`)).text()
    expect(rendering).toContain('Steuerbefreiung für Kleinunternehmer')
    await p.getByRole('row', { name: /2026-000001/ }).getByRole('button', { name: 'Issue credit note' }).click()
    await p.getByLabel('Issue date').last().fill('2026-10-15')
    await p.getByLabel('Credit reason').fill('Synthetic partial refund'); await p.getByLabel('Credit net amount (EUR)').fill('50.00')
    await p.getByRole('button', { name: 'Issue and post credit note' }).click()
    await expect(p.getByRole('status')).toContainText('2026-000002')
    await p.reload()
    await expect(p.getByRole('row', { name: /2026-000002/ })).toBeVisible()
  }
}
