import { expect, type Page } from '@playwright/test'

export class EBalanceLifecyclePage {
  constructor(private readonly page: Page) {}
  get panel() { return this.page.locator('section').filter({ has: this.page.getByRole('heading', { name: 'Immutable report versions' }) }) }
  async open() {
    await this.page.goto('/e-bilanz/2026')
    await this.page.getByLabel('Filing method').selectOption('direct')
    await expect(this.panel).toBeVisible()
  }
  async download(version: number) {
    const download = this.page.waitForEvent('download')
    await this.panel.getByRole('link', { name: `Download version ${version}`, exact: true }).click()
    return download
  }
}
