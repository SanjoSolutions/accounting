import { expect, type Page } from '@playwright/test'

export class ComplianceSetupPage {
  constructor(private readonly page: Page) {}

  async open() {
    const loaded = this.page.waitForResponse(response => response.url().endsWith('/api/compliance') && response.request().method() === 'GET' && response.ok())
    await this.page.goto('/compliance')
    await loaded
    await expect(this.page.getByRole('heading', { level: 1, name: /Compliance/ })).toBeVisible()
    await this.waitReady()
  }

  async saveCapitalCompanyProfile(input: { legalForm: 'UG' | 'GMBH'; year: number; companyName: string }) {
    await this.waitReady()
    const section = this.page.locator('section').filter({ has: this.page.getByRole('heading', { name: 'Authoritative company and tax profile' }) })
    await this.fillSettled(section, 'Company name', input.companyName)
    await this.fillSettled(section, 'Registered street and house number', 'Test 1')
    await this.fillSettled(section, 'Registered postal code', '10115')
    await this.fillSettled(section, 'Registered city', 'Berlin')
    await this.fillSettled(section, 'Registered country', 'DE')
    await section.getByLabel('Legal form').selectOption(input.legalForm); await this.settle()
    await this.fillSettled(section, 'Register court', 'Berlin')
    await this.fillSettled(section, 'Register number', 'HRB 1')
    await this.fillSettled(section, 'Tax number', '1234567890123')
    await this.fillSettled(section, 'Tax office', 'Berlin')
    await this.fillSettled(section, 'Business activity', 'Software')
    await this.fillSettled(section, 'Authoritative chart', 'CUSTOM:HGB-MICRO')
    await this.fillSettled(section, 'Profile effective from', `${input.year - 1}-01-01`)
    await this.fillSettled(section, 'Amtlicher Gemeindeschlüssel (8 Stellen)', '11000000')
    await this.fillSettled(section, 'Gewerbesteuer-Hebesatz (%)', '410')
    await this.fillSettled(section, 'Change reason', 'Verified company register and master data')
  }

  async createPeriod(year: number) {
    const section = this.page.locator('section').filter({ has: this.page.getByRole('heading', { name: 'Fiscal periods' }) })
    if (await section.locator('.history-list li').filter({ hasText: `${year}-01-01–${year}-12-31` }).count()) return
    await section.getByLabel('Reference year').fill(String(year))
    await section.getByLabel('Label').fill(`HGB ${year}`)
    await section.getByLabel('Starts').fill(`${year}-01-01`)
    await section.getByLabel('Ends').fill(`${year}-12-31`)
    await section.getByLabel('Reason').fill('HGB close acceptance period')
    const refreshed = this.page.waitForResponse(response => response.url().endsWith('/api/compliance') && response.request().method() === 'GET' && response.ok())
    await section.getByRole('button', { name: 'Create stable period' }).click()
    await refreshed
    await this.waitReady()
    await expect(this.page.getByRole('status')).toContainText('fiscal period was created')
    await expect(section.locator('.history-list')).toContainText(`${year}-01-01–${year}-12-31`)
  }

  async onboardHistoricalHgb(years: number[], evidenceId: string) {
    await this.waitReady()
    const section = this.page.locator('section').filter({ has: this.page.getByRole('heading', { name: 'Chart and mapping lifecycle' }) })
    const mappings = [
      { accountNumber: 1200, name: 'Bank', accountType: 'ASSET', normalBalance: 'DEBIT', presentationSign: 1, hgbPosition: 'BS.A.B', eBilanzPosition: 'bs.ass.currAss.cashEquiv.bank', evidenceId },
      { accountNumber: 8400, name: 'Revenue', accountType: 'REVENUE', normalBalance: 'CREDIT', presentationSign: 1, hgbPosition: 'IS.M.1', eBilanzPosition: 'is.netIncome.regular.operatingTC.grossTradingProfit.totalOutput', evidenceId },
    ]
    await section.getByLabel('Custom chart ID').fill('CUSTOM:HGB-MICRO')
    await section.getByLabel('Effective account mappings (JSON)').fill(JSON.stringify(mappings, null, 2))
    const historical = section.locator('fieldset').filter({ hasText: 'Evidence-qualified historical HGB onboarding' })
    await historical.getByLabel('Historical HGB fiscal years').fill(years.join(', '))
    await historical.getByLabel('Retained evidence document ID').fill(evidenceId)
    await historical.getByLabel('Change reason').fill('Reviewed register profile and HGB presentation mapping')
    const refreshed = this.page.waitForResponse(response => response.url().endsWith('/api/compliance') && response.request().method() === 'GET' && response.ok())
    await historical.getByRole('button', { name: 'Onboard historical HGB profile and mappings' }).click()
    await refreshed
    await this.waitReady()
    await expect(this.page.getByRole('status')).toContainText('historical HGB profile and mappings were onboarded')
  }

  async visibleMappingIds(year: number) {
    const section = this.page.locator('section').filter({ has: this.page.getByRole('heading', { name: 'Chart and mapping lifecycle' }) })
    const details = section.locator('details')
    await details.locator('summary').click()
    const mappings = JSON.parse((await details.locator('pre').textContent()) || '[]') as Array<{ id: string }>
    return mappings.filter(item => String((item as { effectiveFrom?: string }).effectiveFrom ?? '').startsWith(String(year))).map(item => item.id)
  }

  async configureReviewPolicy(ownerId: string, reviewerId: string) {
    const section = this.page.locator('fieldset').filter({ hasText: 'Jurisdiction, reviewers and recovery policy' })
    await section.getByLabel('Operator user IDs').fill(`${ownerId}, ${reviewerId}`)
    await section.getByLabel('Allowed storage regions').fill('DE')
    await section.getByLabel('Recovery point objective (minutes)').fill('60')
    await section.getByLabel('Recovery time objective (minutes)').fill('60')
    await section.getByLabel('Backup key ID').fill('e2e-hgb-key')
    await section.getByLabel('Policy reason').fill('Independent HGB reviewer')
    await section.getByRole('button', { name: 'Save jurisdiction and recovery policy' }).click()
    await expect(this.page.getByRole('status')).toContainText('jurisdiction and recovery policy was saved')
  }

  async createAnnualAccounts(periodId: string) {
    const section = this.page.locator('fieldset').filter({ hasText: 'Prepare annual-accounts package' })
    await section.getByLabel('Fiscal period').selectOption(periodId)
    await section.getByLabel('Preparation reason').fill('Generate reviewed HGB annual accounts')
    const created = this.page.waitForResponse(response => response.url().endsWith('/api/compliance') && response.request().method() === 'POST' && response.ok())
    await section.getByRole('button', { name: 'Prepare annual accounts' }).click()
    const body = await (await created).json()
    await expect(this.page.getByRole('status')).toContainText('annual-accounts package was prepared')
    const packageId = (body.data ?? body).id as string
    await expect(this.page.getByLabel('Prepared annual-accounts package').locator(`option[value="${packageId}"]`)).toHaveCount(1)
    return packageId
  }

  async approveAnnualAccounts(packageId: string) {
    const section = this.page.locator('fieldset').filter({ hasText: 'Independent annual-accounts approval' })
    await section.getByLabel('Prepared annual-accounts package').selectOption(packageId)
    await section.getByLabel('Approval reason').fill('Independent annual accounts approval')
    await section.getByRole('button', { name: 'Approve annual accounts independently' }).click()
    await expect(this.page.getByRole('status')).toContainText('annual-accounts package was independently approved')
  }

  async saveAuthoritativeCityChange(input: { city: string; effectiveFrom: string }) {
    await this.open()
    const section = this.page.locator('section').filter({ has: this.page.getByRole('heading', { name: 'Authoritative company and tax profile' }) })
    await section.getByLabel('Registered city').fill(input.city)
    await section.getByLabel('Profile effective from').fill(input.effectiveFrom)
    await section.getByLabel('Change reason').fill('Verified registered-office correction for the E-Bilanz source cohort')
    await section.getByRole('button', { name: 'Save effective profile' }).click()
    await expect(this.page.getByRole('status')).toContainText('The authoritative profile was saved.')
  }

  async requestPeriodReopen(periodId: string) {
    const data = await this.runOperation('period.reopen.request', { periodId, reason: 'Authoritative E-Bilanz source changed after the prior lock' })
    return (data as { id: string }).id
  }

  async approvePeriodReopen(requestId: string) {
    await this.runOperation('period.reopen.decide', { requestId, approve: true, reason: 'Independently approved corrected-source reclose' })
  }

  async runOperation(operation: string, payload: Record<string, unknown>) {
    const section = this.page.locator('section').filter({ has: this.page.getByRole('heading', { name: 'Controlled workflows and operator controls' }) })
    const form = section.locator('form').filter({ has: this.page.getByRole('button', { name: 'Execute controlled operation' }) })
    await form.locator('select').selectOption(operation)
    await form.locator('textarea').fill(JSON.stringify(payload, null, 2))
    const completed = this.page.waitForResponse(response => response.url().endsWith('/api/compliance') && response.request().method() === 'POST' && response.ok())
    await form.getByRole('button', { name: 'Execute controlled operation' }).click()
    const body = await (await completed).json()
    await expect(this.page.getByRole('status')).toContainText('operation completed')
    return body.data ?? body
  }

  private async fillSettled(scope: import('@playwright/test').Locator, label: string, value: string) { await scope.getByLabel(label).fill(value); await this.settle() }
  private async settle() { await this.page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))) }
  private async waitReady() { const workspace = this.page.locator('.compliance-workspace'); await expect(workspace).toHaveAttribute('aria-busy', 'false'); await expect(workspace).toHaveAttribute('data-compliance-ready', 'true') }

  async visiblePeriodId(year: number) {
    const item = this.page.locator('.history-list li').filter({ hasText: `${year}-01-01–${year}-12-31` })
    return (await item.locator('code').textContent())!.trim()
  }

}

export class AccessPage {
  constructor(private readonly page: Page) {}
  async open() { await this.page.goto('/access'); await expect(this.page.getByRole('heading', { name: 'Users and roles' })).toBeVisible() }
  async activeTenantId() { return (await this.page.locator('p code').first().textContent())!.trim() }
  async grantAccountant(email: string) {
    await this.page.getByLabel('Registered user email').fill(email)
    await this.page.getByLabel('Role').selectOption('ACCOUNTANT')
    await this.page.getByLabel('Reason').fill('Independent HGB review assignment')
    await this.page.getByRole('button', { name: 'Save access' }).click()
    await expect(this.page.getByRole('status')).toContainText('Access saved')
  }
  async selectCompany(ownerId: string) {
    const item = this.page.locator('li').filter({ hasText: ownerId })
    const button = item.getByRole('button', { name: 'Use this company' })
    await expect(button).toBeVisible()
    await button.click()
    await expect(this.page.locator('p code').first()).toHaveText(ownerId)
  }
}
