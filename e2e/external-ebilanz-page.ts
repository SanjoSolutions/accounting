import { expect, type Page } from '@playwright/test'

export class ExternalEBalancePage {
  constructor(private readonly page: Page) {}
  get panel() { return this.page.getByRole('region', { name: 'File with myebilanz BASIS' }) }
  async open() {
    await this.page.goto('/e-bilanz/2026')
    if (new URL(this.page.url()).origin !== 'http://127.0.0.1:3112') throw new Error('External E-Bilanz browser workflow must use isolated port 3112')
    await expect(this.panel.getByLabel('Saved export version')).toBeVisible()
  }
  async select(id: string) { await this.panel.getByLabel('Saved export version').selectOption(id) }
  async download() {
    const download = this.page.waitForEvent('download')
    await this.panel.getByRole('link', { name: 'Download export package', exact: true }).click()
    return download
  }
  async previewInstructions() {
    await this.panel.getByRole('button', { name: 'View instructions' }).click()
    await expect(this.panel.locator('pre')).toContainText('Externe E-Bilanz: myebilanz BASIS')
  }
  async attachManualClaim() {
    const details = this.panel.locator('details').filter({ hasText: 'Record external evidence for version' })
    await details.locator('summary').click()
    await details.getByLabel('Evidence type').selectOption('ACCEPTANCE_CLAIM')
    await details.getByLabel('Date and time on evidence').fill('2026-10-01T12:00')
    await details.getByLabel('Evidence file (max. 5 MiB)').setInputFiles({ name: 'synthetic-receipt.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic user receipt; no real authority transmission.') })
    await details.getByLabel('Explanation and changes in receiving program').fill('Synthetic historical receipt. Source data supplemented in receiver; not authenticated.')
    await details.getByLabel('I explicitly associate this evidence with the displayed export version and its SHA-256.').check()
    await details.getByRole('button', { name: 'Save user evidence' }).click()
    await expect(this.panel.getByRole('status')).toContainText('Official acceptance remains unauthenticated')
    await expect(this.panel.getByRole('link', { name: 'Download evidence' })).toBeVisible()
  }
}
