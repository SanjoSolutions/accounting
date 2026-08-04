import { expect, type Page } from '@playwright/test'

export class EBalancePage {
  constructor(private readonly page: Page) {}

  async open(year: number) {
    await this.page.goto(`/e-bilanz/${year}`)
    await expect(this.page.getByText(/Loaded from the year-effective, versioned company profile/)).toBeVisible()
  }

  async expectAuthoritativeMasterData(expected: { companyName: string; street: string; postalCode: string; city: string; taxNumber: string; legalForm: string }) {
    await expect(this.page.getByLabel('Company name')).toHaveValue(expected.companyName)
    await expect(this.page.getByLabel('Street and house number')).toHaveValue(expected.street)
    await expect(this.page.getByLabel('Postal code')).toHaveValue(expected.postalCode)
    await expect(this.page.getByLabel('City')).toHaveValue(expected.city)
    await expect(this.page.getByLabel('13-digit ELSTER tax number')).toHaveValue(expected.taxNumber)
    await expect(this.page.getByLabel('Legal form')).toHaveValue(expected.legalForm)
  }

  async exportCurrentValidationPackage(year: number) {
    const download = this.page.waitForEvent('download')
    await this.page.getByRole('button', { name: 'Create XBRL validation package' }).click()
    expect((await download).suggestedFilename()).toBe(`e-bilanz-${year}-pruefpaket.zip`)
    await expect(this.page.getByText('Exact locked-close evidence · CURRENT')).toBeVisible()
    await expect(this.page.getByText(/v1 · EXPORTED · CURRENT/)).toBeVisible()
  }

  async expectAuthoritativeSourceStale() {
    await expect(this.page.getByLabel('City')).toHaveValue('Berlin-Mitte')
    await expect(this.page.getByLabel('City')).toHaveAttribute('readonly', '')
    await expect(this.page.getByRole('alert').filter({ hasText: 'Regeneration and revalidation required' })).toBeVisible()
    await expect(this.page.getByText(/v1 · EXPORTED · STALE/)).toBeVisible()
    await expect(this.page.getByRole('button', { name: 'Validate officially with ERiC' })).toBeDisabled()
    await expect(this.page.getByRole('button', { name: 'Regenerate and revalidate XBRL package' })).toBeDisabled()
    await expect(this.page.getByRole('link', { name: 'Re-run and re-lock the HGB close' })).toBeVisible()
  }

  async exportRemediatedAuthoritativePackage(year: number) {
    const download = this.page.waitForEvent('download')
    await this.page.getByRole('button', { name: 'Regenerate and revalidate XBRL package' }).click()
    expect((await download).suggestedFilename()).toBe(`e-bilanz-${year}-pruefpaket.zip`)
    await expect(this.page.getByRole('alert').filter({ hasText: 'Regeneration and revalidation required' })).toBeHidden()
    await expect(this.page.getByText(/v2 · EXPORTED · CURRENT/)).toBeVisible()
    await expect(this.page.getByText(/v1 · EXPORTED · STALE/)).toBeVisible()
    const current = this.page.locator('.list-group-item').filter({ hasText: 'v2 · EXPORTED · CURRENT' })
    await expect(current.getByText(/Close generation/)).toBeVisible()

    await this.page.reload()
    await expect(this.page.getByText(/v2 · EXPORTED · CURRENT/)).toBeVisible()
    await expect(this.page.getByText(/v1 · EXPORTED · STALE/)).toBeVisible()
  }
}
