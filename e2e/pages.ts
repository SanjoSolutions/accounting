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
    await this.page.getByLabel('Chart of accounts').selectOption('SKR04')
    await this.page.getByRole('button', { name: 'Save' }).click()
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
