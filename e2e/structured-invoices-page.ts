import { readFile } from 'node:fs/promises'
import { expect, type Page } from '@playwright/test'

export class StructuredInvoicesPage {
  constructor(private readonly page: Page) {}

  async signUp(name: string, email: string, password: string) {
    await this.page.goto('/sign-up')
    await this.page.context().addCookies([{ name: 'NEXT_LOCALE', value: 'en', url: new URL(this.page.url()).origin }])
    await this.page.reload()
    await this.page.getByLabel('Name').fill(name); await this.page.getByLabel('Email').fill(email); await this.page.getByLabel('Password').fill(password)
    await this.page.getByRole('button', { name: 'Create account', exact: true }).click(); await expect(this.page).toHaveURL('/')
  }

  async configureIssuerAndCompany() {
    await this.page.goto('/settings')
    await this.page.getByLabel('Name', { exact: true }).fill('Browser Test UG (haftungsbeschränkt)')
    await this.page.getByLabel('Invoice contact name').fill('Accounts receivable')
    await this.page.getByLabel('Invoice contact telephone').fill('+49 30 123456')
    await this.page.getByLabel('Invoice contact email').fill('billing@example.test')
    await this.page.getByLabel('Street and house number').fill('Musterstraße 1')
    await this.page.getByLabel('Zip code').fill('10115')
    await this.page.getByLabel('City').fill('Berlin')
    await this.page.getByLabel('Country').fill('DE')
    await Promise.all([this.page.waitForResponse(response => response.url().endsWith('/api/settings') && response.request().method() === 'PUT'), this.page.getByRole('button', { name: 'Save' }).click()])

    await Promise.all([this.page.waitForResponse(response => response.url().includes('/api/compliance') && response.request().method() === 'GET'), this.page.goto('/compliance')])
    await this.page.getByLabel('Company name').fill('Browser Test UG (haftungsbeschränkt)')
    await this.page.getByLabel('Registered street and house number').fill('Musterstraße 1')
    await this.page.getByLabel('Registered postal code').fill('10115')
    await this.page.getByLabel('Registered city').fill('Berlin')
    await this.page.getByLabel('Registered country').fill('DE')
    await this.page.getByLabel('Legal form').selectOption('UG')
    await this.page.getByLabel('Register court').fill('Berlin-Charlottenburg')
    await this.page.getByLabel('Register number').fill('HRB 123456 B')
    await this.page.getByLabel('Tax number').fill('12/345/67890')
    await this.page.getByLabel('VAT ID').fill('DE123456789')
    await this.page.getByLabel('Tax office').fill('Berlin')
    await this.page.getByLabel('Business activity').fill('Software development')
    await this.page.getByLabel('Amtlicher Gemeindeschlüssel (8 Stellen)').fill('11000000')
    await this.page.getByLabel('Gewerbesteuer-Hebesatz (%)').fill('410')
    await this.page.getByLabel('Change reason').first().fill('Set invoice master data for browser proof')
    await this.page.getByRole('button', { name: 'Save effective profile' }).click()
    await expect(this.page.getByRole('status')).toContainText('authoritative profile was saved')
  }

  async initializeNumbering(year: number) {
    await this.page.getByRole('link', { name: 'Invoices', exact: true }).click()
    await expect(this.page.getByRole('heading', { name: 'XRechnung 3.0 invoices' })).toBeVisible()
    await this.page.getByLabel('Invoice year').fill(String(year))
    await this.page.getByLabel('First unused invoice number', { exact: true }).fill('1')
    await this.page.getByLabel('I confirm this is the first unused invoice number', { exact: true }).check()
    await this.page.getByRole('button', { name: 'Initialize numbering' }).click()
    await expect(this.page.getByRole('status')).toContainText('numbering is ready')
  }

  async issueStandardInvoice(year: number, issueDate = `${year}-08-04`, sequence = 1) {
    await this.page.getByLabel('Issue date').fill(issueDate); await this.page.getByLabel('Supply date').fill(issueDate)
    await this.page.getByLabel('Buyer reference / Leitweg-ID').fill('04011000-12345-03'); await this.page.getByLabel('Electronic address scheme').selectOption('0204'); await this.page.getByLabel('Buyer electronic address').fill('04011000-12345-03'); await this.page.getByLabel('Buyer name').fill('Kunde GmbH'); await this.page.getByLabel('Buyer street and house number').fill('Kundenweg 2'); await this.page.getByLabel('Buyer postal code').fill('50667'); await this.page.getByLabel('Buyer city').fill('Köln'); await this.page.getByLabel('Buyer country').fill('DE')
    await this.page.getByLabel('Description row 1').fill('Softwareberatung August 2026'); await this.page.getByLabel('Quantity row 1').fill('1'); await this.page.getByLabel('Unit row 1').fill('C62'); await this.page.getByLabel('Net amount row 1').fill('100.00'); await this.page.getByLabel('VAT rate row 1').selectOption('19')
    await this.page.getByLabel('Payment terms').fill('Payable within 14 days.'); await this.page.getByLabel('IBAN').fill('DE89370400440532013000')
    await expect(this.page.getByText('€100.00', { exact: true })).toBeVisible(); await expect(this.page.getByText('€19.00', { exact: true })).toBeVisible(); await expect(this.page.getByText('€119.00', { exact: true })).toBeVisible()
    await this.page.getByRole('button', { name: 'Issue invoice' }).click()
    const invoiceNumber = `${year}-${String(sequence).padStart(6, '0')}`
    await expect(this.page.getByRole('status')).toContainText(invoiceNumber)
    await expect(this.page.getByRole('row', { name: new RegExp(invoiceNumber) })).toBeVisible()
  }

  async provePreviewDownloadAndReload(year: number) {
    const row = this.page.getByRole('row', { name: new RegExp(`${year}-000001`) })
    const [preview] = await Promise.all([this.page.context().waitForEvent('page'), row.getByRole('link', { name: 'Preview' }).click()])
    await expect(preview.getByText('Kunde GmbH')).toBeVisible(); await expect(preview.getByText('Softwareberatung August 2026')).toBeVisible(); await expect(preview.locator('body')).toContainText('119.00 EUR'); await preview.close()
    const downloadPromise = this.page.waitForEvent('download'); await row.getByRole('link', { name: 'Download XML' }).click(); const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(/\.xml$/)
    const path = await download.path(); expect(path).toBeTruthy(); const xml = await readFile(path!, 'utf8'); expect(xml).toContain(`${year}-000001`); expect(xml).toContain('Kunde GmbH')
    expect(xml).toContain('urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0'); expect(xml).toContain('<cbc:BuyerReference>04011000-12345-03</cbc:BuyerReference>'); expect(xml.match(/<cbc:EndpointID schemeID="9930">/g)).toHaveLength(1); expect(xml).toContain('<cbc:EndpointID schemeID="0204">04011000-12345-03</cbc:EndpointID>'); expect(xml).toContain('<cbc:ElectronicMail>billing@example.test</cbc:ElectronicMail>')
    await this.page.reload(); await expect(this.page.getByRole('row', { name: new RegExp(`${year}-000001`) })).toBeVisible()
    await this.page.getByRole('link', { name: 'Customers & open items' }).click()
    await expect(this.page.getByRole('row', { name: new RegExp(`${year}-000001.*Kunde GmbH.*€119.00.*€119.00.*OPEN`) })).toBeVisible()
    await this.page.getByRole('link', { name: 'Journal', exact: true }).click()
    const journal = this.page.locator('article').filter({ hasText: `Outgoing invoice ${year}-000001` })
    await expect(journal).toContainText('1400 · Forderungen'); await expect(journal).toContainText(/Soll.*119/)
    await expect(journal).toContainText('8400 · Erlöse 19 % USt'); await expect(journal).toContainText(/Haben.*100/)
    await expect(journal).toContainText('1776 · Umsatzsteuer 19 %'); await expect(journal).toContainText(/Haben.*19/)
  }

  async issuePartialCreditAndProveAccounting(year: number) {
    await this.page.getByRole('link', { name: 'Invoices', exact: true }).click(); const original = this.page.getByRole('row', { name: new RegExp(`${year}-000001`) })
    await original.getByRole('button', { name: 'Issue credit note' }).click(); await expect(this.page.getByRole('heading', { name: `Credit note for ${year}-000001` })).toBeVisible()
    await this.page.getByLabel('Issue date').last().fill(`${year}-08-05`); await this.page.getByLabel('Credit reason').fill('Partial service reduction'); await this.page.getByLabel('Credit net amount (EUR)').fill('50.00')
    await this.page.getByRole('button', { name: 'Issue and post credit note' }).click(); await expect(this.page.getByRole('status')).toContainText(`${year}-000002`)
    await expect(this.page.getByRole('row', { name: new RegExp(`${year}-000002.*credit-note`) })).toBeVisible(); await this.page.reload(); await expect(this.page.getByRole('row', { name: new RegExp(`${year}-000002`) })).toBeVisible()
    await this.page.getByRole('link', { name: 'Customers & open items' }).click()
    await expect(this.page.getByRole('row', { name: new RegExp(`${year}-000001.*€119.00.*€59.50.*PARTIAL`) })).toBeVisible()
    await expect(this.page.getByRole('row', { name: new RegExp(`${year}-000002.*€59.50.*€0.00.*SETTLED`) })).toBeVisible()
    await this.page.getByRole('link', { name: 'Journal', exact: true }).click(); const credit = this.page.locator('article').filter({ hasText: `Credit note ${year}-000002` })
    await expect(credit).toContainText('8400 · Erlöse 19 % USt'); await expect(credit).toContainText(/Soll.*50/); await expect(credit).toContainText('1776 · Umsatzsteuer 19 %'); await expect(credit).toContainText(/Soll.*9,50/); await expect(credit).toContainText('1400 · Forderungen'); await expect(credit).toContainText(/Haben.*59,50/)
    await this.page.reload(); await expect(this.page.locator('article').filter({ hasText: `Credit note ${year}-000002` })).toBeVisible()
  }
}
