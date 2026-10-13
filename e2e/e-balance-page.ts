import { expect, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { strFromU8, unzipSync } from 'fflate'

export class EBalancePage {
  constructor(private readonly page: Page) {}

  async open(year: number) {
    await this.page.goto(`/e-bilanz/${year}`)
    await expect(this.page.getByText(/Loaded from the year-effective, versioned company profile/)).toBeVisible({ timeout: 30_000 })
  }

  async expectAuthoritativeMasterData(expected: { companyName: string; street: string; postalCode: string; city: string; taxNumber: string; legalForm: string }) {
    await expect(this.page.getByLabel('Company name')).toHaveValue(expected.companyName)
    await expect(this.page.getByLabel('Street and house number')).toHaveValue(expected.street)
    await expect(this.page.getByLabel('Postal code')).toHaveValue(expected.postalCode)
    await expect(this.page.getByLabel('Town', { exact: true })).toHaveValue(expected.city)
    await expect(this.page.getByLabel('13-digit ELSTER tax number')).toHaveValue(expected.taxNumber)
    await expect(this.page.getByLabel('Legal form')).toHaveValue(expected.legalForm)
  }

  async exportCurrentValidationPackage(year: number) {
    const download = this.page.waitForEvent('download')
    await this.page.getByRole('button', { name: 'Create XBRL validation package' }).click()
    const artifact = await download
    expect(artifact.suggestedFilename()).toBe(`e-bilanz-${year}-pruefpaket.zip`)
    const files = unzipSync(await readFile((await artifact.path())!))
    const xml = strFromU8(files[`e-bilanz-${year}.xbrl`])
    const dataset = JSON.parse(strFromU8(files['export-data.json']))
    const diagnostics = JSON.parse(strFromU8(files['local-validation.json']))
    expect(dataset).toMatchObject({ schemaVersion: 'EBILANZ_EXPORT_V1', fiscalYear: { year }, totals: { taxNetIncomeCents: 11900 } })
    expect(diagnostics).toMatchObject({ level: 'LOCAL_STRUCTURAL', valid: true, officialAcceptance: 'NOT_VALIDATED', closeGenerationId: dataset.closeGenerationId, reportChecksum: createHash('sha256').update(xml).digest('hex') })
    expect(xml).toContain(`>${year}-01-01</xbrli:startDate>`)
    expect(xml).not.toContain('accounting:reportPayload')
    await expect(this.page.getByText('Exact locked-close evidence · CURRENT')).toBeVisible()
    await expect(this.page.getByText(/v1 · EXPORTED · CURRENT/)).toBeVisible()
  }

  async approveSyntheticTaxBalance(fiscalYearId: string, year: number, evidenceId: string) {
    const overview = await (await this.page.request.get(`/api/compliance/e-bilanz?fiscalYearId=${fiscalYearId}`)).json()
    const closeGenerationId = overview.data.closeEvidence.currentCloseGenerationId
    expect(closeGenerationId).toBeTruthy()
    const response = await this.page.request.post('/api/compliance/e-bilanz', { data: {
      action: 'reconciliation.record', fiscalYearId, kind: 'TAX_BALANCE', reason: 'Approve synthetic no-difference tax balance', evidenceIds: [evidenceId],
      payload: { schemaVersion: 'EBILANZ_TAX_BALANCE_V1', closeGenerationId, complete: true, adjustments: [], assetMappings: [],
        bvv: { openingEquityCents: 0, capitalAdjustmentsCents: 0, contributionsCents: 0, distributionsCents: 0 },
        gcd: { business: 'Software', country: 'DE', houseNumber: '1', previousPeriod: { start: `${year - 1}-01-01`, end: `${year - 1}-12-31` }, domesticOrdinaryCompany: true, businessId: null,
          shareholders: [{ id: 'owner', name: 'Synthetic Owner', legalStatus: 'NPP', shareNumerator: 1, shareDenominator: 1, taxNumber: null, taxId: '12345678901', businessId: null }] },
        nilReasons: { 'company.businessId': 'Synthetic fixture has no assignment.', 'shareholder.owner.taxNumber': 'Synthetic fixture has no assignment.', 'shareholder.owner.businessId': 'Private natural person.' } },
    } })
    expect(await response.json()).toMatchObject({ success: true })
    expect(response.ok()).toBe(true)
  }

  async expectAuthoritativeSourceStale() {
    await expect(this.page.getByLabel('Town', { exact: true })).toHaveValue('Berlin-Mitte')
    await expect(this.page.getByLabel('Town', { exact: true })).toHaveAttribute('readonly', '')
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
