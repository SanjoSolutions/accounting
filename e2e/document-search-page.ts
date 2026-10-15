import { expect, type Page } from '@playwright/test'
import { UgBookkeepingPage } from './ug-bookkeeping-page'

export class DocumentSearchPage {
  constructor(private readonly page: Page) {}
  get picker() { return this.page.locator('.document-picker-panel') }
  get cards() { return this.picker.locator('.document-card') }

  async open() {
    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    await new UgBookkeepingPage(this.page).signUp(`Search ${unique}`, `search-${unique}@example.test`, 'Synthetic-search-password-2026')
    await this.page.goto('/bookings')
    const add = this.page.getByRole('button', { name: 'Add document', exact: true })
    if (await add.isVisible()) await add.click()
    await expect(this.page.getByRole('searchbox', { name: 'Search documents' })).toBeVisible()
  }

  async upload(name: string, buffer: Buffer, expectedText: string) {
    const uploaded = this.page.waitForResponse(response => response.url().endsWith('/api/documents') && response.request().method() === 'POST')
    await this.picker.locator('input[type="file"]').setInputFiles({ name, mimeType: 'application/pdf', buffer })
    const response = await uploaded
    expect(response.status()).toBe(201)
    const body = await response.json()
    await expect.poll(async () => {
      const result = await this.page.request.get(`/api/documents/search?q=${encodeURIComponent(expectedText)}`)
      const data = await result.json()
      return data.data.documents.some((item: { id: string }) => item.id === body.data.id)
    }, { timeout: 90_000 }).toBe(true)
    const add = this.page.getByRole('button', { name: 'Add document', exact: true })
    if (await add.isVisible()) await add.click()
  }

  async search(query: string, names: string[]) {
    await this.page.getByRole('searchbox', { name: 'Search documents' }).fill(query)
    await expect(this.cards).toHaveCount(names.length)
    for (const name of names) await expect(this.cards.filter({ hasText: name })).toBeVisible()
  }

  async proveSearchAndSelection() {
    await this.search('ALPHA', ['alpha-Büro'])
    await this.search('BURO', ['alpha-Büro'])
    await this.cards.first().click()
    await expect(this.page.locator('.document-tabs')).toContainText('alpha-Büro')
    await this.search('e2e-2026-001', ['alpha-Büro'])
    await expect(this.picker).toContainText('e2e-2026-001')
    await this.search('nothing-matches-xyz', [])
    await expect(this.picker).toContainText('No matching documents.')
    await expect(this.page.locator('.document-tabs')).toContainText('alpha-Büro')
    await this.page.getByRole('button', { name: 'Clear', exact: true }).click()
    await expect(this.cards).toHaveCount(1)
    await this.page.reload()
    await this.search('e2e-2026-001', ['alpha-Büro'])
  }

  async screenshot(name: string) {
    await this.page.screenshot({ path: `.playwright/document-search/${name}-desktop.png`, fullPage: true })
    await this.page.setViewportSize({ width: 390, height: 844 })
    await this.page.screenshot({ path: `.playwright/document-search/${name}-mobile.png`, fullPage: true })
  }
}
