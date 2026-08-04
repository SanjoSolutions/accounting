import { expect, type Page } from '@playwright/test'

export class CommercialPage {
  constructor(private readonly page: Page) {}

  async signUp(name: string, email: string, password: string) {
    await this.page.goto('/sign-up')
    await this.page.context().addCookies([{ name: 'NEXT_LOCALE', value: 'en', url: new URL(this.page.url()).origin }])
    await this.page.reload()
    await this.page.getByLabel('Name').fill(name)
    await this.page.getByLabel('Email').fill(email)
    await this.page.getByLabel('Password').fill(password)
    await this.page.getByRole('button', { name: 'Create account', exact: true }).click()
    await expect(this.page).toHaveURL('/')
  }

  async openFromNavigation() {
    await this.page.getByRole('link', { name: 'Customers & open items' }).click()
    await expect(this.page).toHaveURL('/receivables')
    await expect(this.page.getByRole('heading', { name: 'Customers & open items' })).toBeVisible()
  }

  async createCustomer(partnerNumber: string, name: string) {
    await this.page.getByLabel('Customer / supplier number').fill(partnerNumber)
    await this.page.getByLabel('Business partner name').fill(name)
    await this.page.getByLabel('Role').selectOption('CUSTOMER')
    await this.page.getByLabel('Payment term in days').fill('30')
    await this.page.getByRole('button', { name: 'Create business partner' }).click()
    await expect(this.page.getByRole('status')).toContainText('business partner was created')
    const row = this.page.getByRole('row', { name: new RegExp(`${partnerNumber}.*${name}.*Customer.*30 days`) })
    await expect(row).toBeVisible()
  }

  async expectCustomerSurvivesReload(partnerNumber: string, name: string) {
    await this.page.reload()
    await expect(this.page.getByRole('row', { name: new RegExp(`${partnerNumber}.*${name}`) })).toBeVisible()
    await expect(this.page.getByText('No open items yet. Final posted invoices appear here automatically.')).toBeVisible()
  }
}
