import { expect, type Page } from '@playwright/test'

export class ApplicationPage {
  constructor(readonly page: Page) {}

  async open(path = '/') {
    await this.page.goto(path)
  }

  async followNavigation(name: string) {
    await this.page.getByRole('link', { name, exact: true }).click()
  }

  async expectHeading(name: string | RegExp) {
    await expect(this.page.getByRole('heading', { level: 1, name })).toBeVisible()
  }
}

export class AuthenticationPage extends ApplicationPage {
  async signIn(email: string, password: string) {
    await this.page.getByLabel('Email').fill(email)
    await this.page.getByLabel('Password').fill(password)
    await this.page.getByRole('button', { name: 'Sign in', exact: true }).click()
  }

  async signUp(name: string, email: string, password: string) {
    await this.page.getByLabel('Name').fill(name)
    await this.page.getByLabel('Email').fill(email)
    await this.page.getByLabel('Password').fill(password)
    await this.page.getByRole('button', { name: 'Create account', exact: true }).click()
  }
}

export class BookingsPage extends ApplicationPage {
  async chooseDocument(name: string) {
    await this.page.getByRole('button', { name }).click()
  }

  async selectAccount(line: number, account: string) {
    await this.page.getByRole('combobox', { name: `Account row ${line}` }).click()
    await this.page.getByRole('option', { name: account }).click()
  }

  async completeBalancedPosting() {
    await this.page.getByLabel('Posting text').fill('Office supplies')
    await this.selectAccount(1, '4930 · Office supplies')
    await this.page.getByLabel('Debit row 1').fill('119')
    await this.selectAccount(2, '1200 · Bank')
    await this.page.getByLabel('Credit row 2').fill('119')
  }
}

export class SettingsPage extends ApplicationPage {
  async updateIssuer(name: string) {
    await this.page.getByLabel('Name').fill(name)
    await this.page.getByLabel(/Chart of accounts|Kontenrahmen/).selectOption('SKR04')
    await this.page.getByRole('button', { name: /Save|Speichern/ }).click()
  }

  async configureDomesticReverseCharge(chart: 'SKR03' | 'SKR04', inputVatAccount: string, outputVatAccount: string, tenantVatId?: string) {
    await this.open('/settings')
    await this.page.getByLabel(/Chart of accounts|Kontenrahmen/).selectOption(chart)
    await this.page.getByLabel(/§13b deductible input VAT account|§13b-Konto abziehbare Vorsteuer/).fill(inputVatAccount)
    await this.page.getByLabel(/§13b output VAT liability account|§13b-Konto Umsatzsteuer/).fill(outputVatAccount)
    if (tenantVatId) {
      const result = await this.page.evaluate(async ({ vatId, chart }) => {
        const profile = { companyName: 'Buyer GmbH', registeredAddress: { streetAndHouseNumber: 'Ring 2', zipCode: '10117', city: 'Berlin', country: 'DE' }, legalForm: 'GMBH', registerCourt: 'Berlin', registerNumber: 'HRB 1', taxNumber: '12/345/67890', vatId, taxOffice: 'Berlin', vatRegime: 'STANDARD', vatFilingFrequency: 'MONTHLY', activity: 'Software services', sizeClass: 'SMALL', chart, elections: [] }
        const response = await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ companyProfile: profile, companyProfileEffectiveFrom: new Date().toISOString().slice(0, 10), changeReason: 'Verified tenant VAT identity for EU supplier service' }) })
        return { status: response.status, body: await response.json() }
      }, { vatId: tenantVatId, chart })
      expect(result).toMatchObject({ status: 200, body: { success: true } })
    }
    await this.page.getByRole('button', { name: /Save|Speichern/, exact: true }).click()
    await expect(this.page.getByText('Settings saved.', { exact: true })).toBeVisible()
  }

  async configureEuAcquisition(chart: 'SKR03' | 'SKR04', inputVatAccount: string, outputVatAccount: string, tenantVatId: string) {
    await this.open('/settings')
    await this.page.getByLabel(/Chart of accounts|Kontenrahmen/).selectOption(chart)
    await this.page.getByLabel(/Intra-community acquisition deductible input VAT account|innergemeinschaftlicher Erwerb.*Vorsteuerkonto/i).fill(inputVatAccount)
    await this.page.getByLabel(/Intra-community acquisition VAT liability account|innergemeinschaftlicher Erwerb.*Umsatzsteuerkonto/i).fill(outputVatAccount)
    const result = await this.page.evaluate(async ({ vatId, chart }) => {
      const profile = { companyName: 'Buyer GmbH', registeredAddress: { streetAndHouseNumber: 'Ring 2', zipCode: '10117', city: 'Berlin', country: 'DE' }, legalForm: 'GMBH', registerCourt: 'Berlin', registerNumber: 'HRB 1', taxNumber: '12/345/67890', vatId, taxOffice: 'Berlin', vatRegime: 'STANDARD', vatFilingFrequency: 'MONTHLY', activity: 'Trade', sizeClass: 'SMALL', chart, elections: [] }
      const response = await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ companyProfile: profile, companyProfileEffectiveFrom: new Date().toISOString().slice(0, 10), changeReason: 'Verified tenant VAT identity for intra-EU goods acquisition' }) })
      return { status: response.status, body: await response.json() }
    }, { vatId: tenantVatId, chart })
    expect(result).toMatchObject({ status: 200, body: { success: true } })
    await this.page.getByRole('button', { name: /Save|Speichern/, exact: true }).click()
    await expect(this.page.getByText('Settings saved.', { exact: true })).toBeVisible()
  }
}

export class AccessPage extends ApplicationPage {
  async grant(email: string, role: 'ADMIN' | 'ACCOUNTANT' | 'READ_ONLY', reason: string) {
    await this.open('/access')
    await this.page.getByLabel('Registered user email').fill(email)
    await this.page.getByLabel('Role').selectOption(role)
    await this.page.getByLabel('Reason').fill(reason)
    await this.page.getByRole('button', { name: 'Save access' }).click()
    await expect(this.page.getByRole('status')).toContainText('audit trail')
  }

  async useCompany(ownerId: string) {
    await this.open('/access')
    const row = this.page.getByRole('listitem').filter({ hasText: ownerId })
    await row.getByRole('button', { name: 'Use this company' }).click()
    await expect(this.page.getByText(`Active company: ${ownerId}`, { exact: false })).toBeVisible()
  }
}

export class SpecialistAuthorizationPage extends ApplicationPage {
  async attemptCompliancePeriodMutation() {
    await this.open('/compliance')
    await this.expectHeading(/Compliance control center|Compliance-Leitstand/)
    const panel = this.page.locator('section').filter({ has: this.page.getByRole('heading', { name: /Fiscal periods|Geschäftsjahresperioden/ }) })
    await panel.getByLabel(/Label|Bezeichnung/).fill('Forbidden read-only period')
    await panel.getByLabel(/Reason|Begründung/).fill('Read-only boundary browser proof')
    const response = this.page.waitForResponse(item => new URL(item.url()).pathname === '/api/compliance' && item.request().method() === 'POST')
    await panel.getByRole('button', { name: /Create stable period|Stabile Periode anlegen/ }).click()
    expect((await response).status()).toBe(403)
    await expect(this.page.getByRole('alert').filter({ hasText: 'role does not permit' })).toBeVisible()
  }

  async expectTaxMutationDeniedBeforeGateway() {
    const result = await this.page.evaluate(async () => {
      const response = await fetch('/api/tax/workflows', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{malformed' })
      return { status: response.status, body: await response.json() }
    })
    expect(result).toMatchObject({ status: 403, body: { success: false, error: expect.stringMatching(/role/) } })
  }
}

export class TaxPage extends ApplicationPage {
  async validateAndSubmit() {
    await this.page.getByRole('button', { name: 'Validate officially' }).click()
    await expect(this.page.getByRole('status')).toContainText('validated')
    await this.page.getByLabel('I explicitly approve this binding transmission.').check()
    await this.page.getByRole('button', { name: 'Submit binding' }).click()
  }
}

export class CompliancePage extends ApplicationPage {
  profileSection() {
    return this.page
      .getByRole('heading', { name: 'Authoritative company and tax profile' })
      .locator('xpath=ancestor::section[1]')
  }

  async saveProfile(reason: string) {
    const section = this.profileSection()
    await section.getByLabel('Change reason').fill(reason)
    await section.getByRole('button', { name: 'Save effective profile' }).click()
  }
}

export class AccountingReportsPage extends ApplicationPage {
  async open2025() {
    const response = this.page.waitForResponse(value =>
      new URL(value.url()).pathname === '/api/accounting-reports'
      && new URL(value.url()).searchParams.get('year') === '2025',
    )
    await this.open('/reports/2025')
    expect((await response).status()).toBe(200)
    await this.expectHeading(/2025/)
  }

  section(name: string | RegExp) {
    return this.page.getByRole('heading', { name }).locator('xpath=ancestor::section[1]')
  }

  async expectSectionContains(name: string | RegExp, ...values: string[]) {
    const section = this.section(name)
    await expect(section).toBeVisible()
    for (const value of values) await expect(section).toContainText(value)
  }

  async searchChart(value: string) {
    const section = this.section(/Chart metadata/i)
    await section.getByRole('searchbox', { name: /Search/i }).fill(value)
    return section
  }

  async openLedgerAccount(account: string) {
    await this.section(/General-ledger account sheets/i).locator('summary').filter({ hasText: new RegExp(`^${account} ·`) }).click()
  }

  async openVoucherFromJournal(name: string) {
    await this.openJournal2025()
    const link = this.page.getByRole('link', { name })
    const href = await link.getAttribute('href')
    expect(href).toMatch(/^\/api\/documents\/[^/]+\/file$/)
    const openedPage = this.page.context().waitForEvent('page')
    await link.click()
    const voucherPage = await openedPage
    await voucherPage.close()
    return this.page.context().request.get(href!)
  }

  async openJournal2025() {
    await this.open('/journal')
    await this.page.getByLabel('Fiscal year').fill('2025')
    await expect(this.page.getByRole('heading', { name: 'Posted entries' })).toBeVisible()
  }
}
