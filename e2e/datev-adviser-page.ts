import { expect, type Page } from '@playwright/test'

export class DatevAdviserPage {
  constructor(private readonly page: Page, private readonly year = 2026) {}

  async signUp(name: string, email: string, password: string) {
    await this.page.goto('/sign-up'); await this.page.context().addCookies([{ name: 'NEXT_LOCALE', value: 'en', url: new URL(this.page.url()).origin }]); await this.page.reload()
    await this.page.getByLabel('Name').fill(name); await this.page.getByLabel('Email').fill(email); await this.page.getByLabel('Password').fill(password)
    await this.page.getByRole('button', { name: 'Create account', exact: true }).click(); await expect(this.page).toHaveURL('/')
  }

  async importSource(bytes: Buffer) {
    await this.page.goto('/export-import')
    await this.page.getByLabel('Select DATEV CSV files').setInputFiles({ name: 'EXTF_Buchungsstapel.csv', mimeType: 'text/csv', buffer: bytes })
    await this.page.getByRole('button', { name: 'Import accounting data' }).click()
    await expect(this.page.getByRole('status')).toContainText('Processed 1 bookings')
  }

  async downloadExport(): Promise<Buffer> {
    await this.page.getByLabel('Fiscal year').first().fill(String(this.year))
    const downloadPromise = this.page.waitForEvent('download')
    await this.page.getByRole('button', { name: 'Download DATEV booking batch' }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toBe(`EXTF_Buchungsstapel_${this.year}.csv`)
    await expect(this.page.getByRole('status')).toContainText(`booking batch for ${this.year} was downloaded`)
    const stream = await download.createReadStream(); const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks)
  }

  async reimportExport(bytes: Buffer) {
    await this.page.getByLabel('Select DATEV CSV files').setInputFiles({ name: `EXTF_Buchungsstapel_${this.year}.csv`, mimeType: 'text/csv', buffer: bytes })
    await this.page.getByRole('button', { name: 'Import accounting data' }).click()
    await expect(this.page.getByRole('status')).toContainText('Processed 2 bookings')
  }
}
