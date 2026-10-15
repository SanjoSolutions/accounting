import { expect, type Page } from '@playwright/test'

export class EuerPage {
  constructor(readonly page: Page) {}
  async configure() {
    const profile = { companyName: 'EÜR Testbetrieb', legalForm: 'SOLE_TRADER', taxNumber: '123/456/78901', taxOffice: 'Berlin', activity: 'Beratung', vatRegime: 'STANDARD', vatFilingFrequency: 'MONTHLY', sizeClass: 'MICRO', chart: 'SKR03', elections: [], registeredAddress: { streetAndHouseNumber: 'Testweg 1', zipCode: '10115', city: 'Berlin', country: 'DE' }, soleTraderTaxProfile: { profitDetermination: 'EUER', incomeType: 'SELF_EMPLOYED', euerEligibilityConfirmed: true } }
    const period = await this.page.request.post('/api/compliance', { data: { action: 'period.create', referenceYear: 2026, label: 'EÜR 2026', startsAt: '2026-01-01', endsAt: '2026-12-31', reason: 'Synthetic EÜR test year' } })
    expect(period.ok(), await period.text()).toBeTruthy()
    const response = await this.page.request.put('/api/settings', { data: { companyProfile: profile, companyProfileEffectiveFrom: '2026-01-01', confirmProfilePreviouslyValid: true, changeReason: 'Synthetic sole trader EÜR facts' } })
    expect(response.ok(), await response.text()).toBeTruthy()
  }
  async open() { await this.page.goto('/tax/2026/euer'); await expect(this.page.getByRole('heading', { name: 'EÜR 2026', exact: true })).toBeVisible(); await expect(this.page.getByRole('button', { name: 'Zahlung hinzufügen' })).toBeEnabled() }
  async add(position: string, amount: string, reference: string) {
    await this.page.getByLabel('Zahlungsdatum', { exact: true }).fill('2026-07-01')
    await this.page.getByLabel('EÜR-Position', { exact: true }).selectOption(position)
    await this.page.getByLabel('Betrag (EUR)', { exact: true }).fill(amount)
    await this.page.getByLabel('Belegreferenz', { exact: true }).fill(reference)
    await this.page.getByLabel('Beschreibung', { exact: true }).fill('Synthetischer Zahlungsvorgang')
    await this.page.getByRole('button', { name: 'Zahlung hinzufügen' }).click()
    await expect(this.page.getByRole('row').filter({ hasText: reference })).toBeVisible()
  }
  async save(version: number) {
    await this.page.getByLabel('Alle Zahlungen und Geldentnahmen/-einlagen', { exact: false }).check()
    await this.page.getByRole('button', { name: 'Version speichern' }).click()
    await expect(this.page.getByRole('status')).toContainText(`Version ${version} gespeichert.`)
  }
}
