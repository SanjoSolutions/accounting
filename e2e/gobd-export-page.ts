import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, type Page } from '@playwright/test'
import { ComplianceSetupPage } from './compliance-setup-page'

export class GobdExportPage {
  private readonly compliance: ComplianceSetupPage
  constructor(private readonly page: Page) { this.compliance = new ComplianceSetupPage(page) }

  async configure(year: number) {
    await this.compliance.open(); await this.compliance.createPeriod(year); await this.compliance.saveCapitalCompanyProfile({ legalForm: 'GMBH', year, companyName: 'GoBD E2E GmbH' })
    const profile = this.page.locator('section').filter({ has: this.page.getByRole('heading', { name: 'Authoritative company and tax profile' }) }); await profile.getByLabel('Profile effective from').fill('2026-08-04')
    const section = this.page.locator('section').filter({ has: this.page.getByRole('heading', { name: 'Chart and mapping lifecycle' }) })
    const form = section.locator('form').first()
    await form.getByLabel('Custom chart ID').fill('CUSTOM:GOBD-E2E')
    await form.getByLabel('Mappings effective from').fill('2026-08-04')
    await form.getByLabel('Effective account mappings (JSON)').fill(JSON.stringify([
      { accountNumber: 1200, name: 'Bank', accountType: 'ASSET', normalBalance: 'DEBIT', hgbPosition: 'BS.A.B.IV', eBilanzPosition: 'bank' },
      { accountNumber: 8400, name: 'Revenue', accountType: 'REVENUE', normalBalance: 'CREDIT', hgbPosition: 'IS.1', eBilanzPosition: 'revenue' },
    ]))
    await form.getByLabel('Change reason').fill('Authoritative GoBD E2E chart activation')
    await form.getByRole('button', { name: 'Import and activate atomically' }).click()
    await expect(this.page.getByRole('status')).toContainText('custom chart was imported and activated')
    return this.compliance.visiblePeriodId(year)
  }

  async create(periodId: string) {
    const record = await this.compliance.runOperation('reporting.audit-export.create', { fiscalPeriodId: periodId, authorityReference: 'AO-147-6-E2E', reason: 'No-mock GoBD export proof' }) as { id: string; checksum: string }
    await expect(this.page.getByRole('link', { name: 'Download verified GoBD package' })).toBeVisible()
    return record
  }

  async downloadAndVerify(packageId: string, year: number) {
    const exactLink = this.page.locator(`a[href="/api/compliance/packages/${packageId}"]`)
    await expect(exactLink).toBeVisible()
    const downloadPromise = this.page.waitForEvent('download'); await exactLink.click(); const download = await downloadPromise
    expect(download.suggestedFilename()).toBe(`gobd-audit-${year}-v1.json`)
    const path = await download.path(); expect(path).toBeTruthy(); const bytes = await readFile(path!); const parsed = JSON.parse(bytes.toString('utf8')) as { manifest: { format: string; packageChecksum: string; files: Array<{ path: string; sha256: string }> }; files: Record<string, string> }
    expect(parsed.manifest.format).toBe('accounting-audit-package'); expect(parsed.manifest.packageChecksum).toMatch(/^[a-f0-9]{64}$/)
    const openings = JSON.parse(parsed.files['data/openingClosing.json']) as Array<{ openingCents: number; closingCents: number }>; expect(openings).toHaveLength(2); expect(openings.every(row => row.openingCents === 0 && row.closingCents === 0)).toBe(true)
    for (const file of parsed.manifest.files) expect(createHash('sha256').update(parsed.files[file.path]).digest('hex')).toBe(file.sha256)
    const response = await this.page.request.get(`/api/compliance/packages/${packageId}`); expect(response.ok()).toBe(true); expect(response.headers()['x-content-sha256']).toBe(createHash('sha256').update(await response.body()).digest('hex'))
  }

  async reloadKeepsDownload(packageId: string) { await this.page.reload(); await expect(this.page.locator(`a[href="/api/compliance/packages/${packageId}"]`)).toBeVisible() }
}
