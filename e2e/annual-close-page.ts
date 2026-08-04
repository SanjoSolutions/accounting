import { expect, type Page } from '@playwright/test'
import { createHgbStatementRuleSet } from '../src/core/hgbStatements'
import type { HgbWorkpaperKind } from '../src/core/hgbClose'

export class AnnualClosePage {
  constructor(private readonly page: Page) {}

  async createExpiredShortFiscalYear2026() {
    await this.page.goto('/compliance')
    await expect(this.page.getByRole('heading', { name: 'Fiscal periods' })).toBeVisible()
    const section = this.page.getByRole('heading', { name: 'Fiscal periods' }).locator('xpath=ancestor::section[1]')
    await section.getByLabel('Reference year').fill('2026')
    await section.getByLabel('Label').fill('Short fiscal year 2026')
    await section.getByLabel('Starts').fill('2026-01-01')
    await section.getByLabel('Ends').fill('2026-06-30')
    await section.getByLabel('Reason').fill('Playwright annual-close acceptance test')
    await section.getByRole('button', { name: 'Create stable period' }).click()
    await expect(this.page.getByRole('status')).toContainText('fiscal period was created')
    await expect(section).toContainText('2026-01-01–2026-06-30 · OPEN')
  }

  async uploadEvidence(pdf: Buffer) {
    await this.page.goto('/bookings')
    const uploaded = this.page.waitForResponse(response => response.url().includes('/api/documents') && response.request().method() === 'POST' && response.ok())
    await this.page.locator('.document-actions input[type="file"]').setInputFiles({ name: 'annual-close-evidence.pdf', mimeType: 'application/pdf', buffer: pdf })
    const body = await (await uploaded).json()
    await expect(this.page.getByRole('button', { name: 'annual-close-evidence' })).toBeVisible()
    return (body.data ?? body).id as string
  }

  async postRevenueWithEvidence(pdf: Buffer, year = 2026) {
    const initialYearLoaded = this.page.waitForResponse(response => response.url().includes('/api/booking-records?year=') && response.request().method() === 'GET' && response.ok())
    await this.page.goto('/bookings')
    await initialYearLoaded
    const yearControl = this.page.getByLabel('Fiscal year')
    if (await yearControl.inputValue() !== String(year)) {
      const yearLoaded = this.page.waitForResponse(response => response.url().includes(`/api/booking-records?year=${year}`) && response.request().method() === 'GET' && response.ok())
      await yearControl.fill(String(year))
      await yearLoaded
    }
    await expect(this.page.getByLabel('Fiscal year')).toHaveValue(String(year))
    await expect(this.page.getByRole('combobox', { name: 'Account row 1' })).toBeEnabled()

    const uploaded = this.page.waitForResponse(response => response.url().includes('/api/documents') && response.request().method() === 'POST' && response.ok())
    await this.page.locator('.document-actions input[type="file"]').setInputFiles({
      name: 'annual-close-evidence.pdf',
      mimeType: 'application/pdf',
      buffer: pdf,
    })
    const uploadBody = await (await uploaded).json()
    await expect(this.page.getByRole('button', { name: 'annual-close-evidence' }).last()).toHaveAttribute('aria-pressed', 'true')

    await this.page.getByLabel('Posting date').fill(`${year}-12-15`)
    await this.page.getByLabel('Posting text').fill('Revenue for annual close')
    await this.selectAccount(1, '1200 · Bank')
    await this.page.getByLabel('Debit row 1').fill('119')
    await this.selectAccount(2, '8400 · Erlöse 19 % USt')
    await this.page.getByLabel('Credit row 2').fill('119')
    await this.page.getByRole('button', { name: 'Post', exact: true }).click()
    await expect(this.page.getByRole('status')).toContainText('transaction has been posted')
    return (uploadBody.data ?? uploadBody).id as string
  }

  async prepareSupportedMicroClose(input: { year: number; legalForm: 'UG' | 'GMBH'; evidenceId: string; mappingIds: string[] }) {
    const { year, legalForm, evidenceId, mappingIds } = input
    const nextYear = year + 1
    await this.page.goto(`/annual-close/${year}`)
    const profile = this.page.locator('details').filter({ hasText: '1. Unternehmensprofil und Größenmerkmale' })
    await profile.locator('summary').click()
    await profile.getByLabel('Rechtsform').selectOption(legalForm)
    await profile.getByLabel('Konzernstatus').selectOption('STANDALONE_NO_EXEMPTION')
    for (const [label, value] of [
      ['In Deutschland registriert', 'true'], ['Unternehmen von öffentlichem Interesse', 'false'], ['Kapitalmarktorientiert oder börsennotiert', 'false'], ['Regulierte Branche', 'false'],
      ['Liquidations- oder Insolvenzbewertung', 'false'], ['Unternehmensfortführung angemessen', 'true'], ['Gründung oder Umwandlung im Geschäftsjahr', 'false'], ['§ 5a GmbHG anwendbar', 'false'],
      ['Vorräte vorhanden', 'false'], ['Anlagevermögen vorhanden', 'false'], ['Angaben nach § 268 Abs. 7 unter der Bilanz', 'true'],
      ['Vorschüsse und Kredite an Geschäftsführung unter der Bilanz', 'true'], ['Zusätzliche Angaben für ein den tatsächlichen Verhältnissen entsprechendes Bild beurteilt', 'true'],
    ] as const) await profile.getByLabel(label).selectOption(value)
    for (const legend of ['Aktuelles Geschäftsjahr', 'Vorjahr']) {
      const facts = profile.locator('fieldset').filter({ has: this.page.getByText(legend, { exact: true }) })
      await facts.getByLabel('Bilanzsumme (Cent)').fill(legend === 'Aktuelles Geschäftsjahr' ? '100' : '90')
      await facts.getByLabel('Umsatzerlöse (Cent)').fill(legend === 'Aktuelles Geschäftsjahr' ? '100' : '90')
      for (let quarter = 1; quarter <= 4; quarter++) await facts.getByLabel(`Beschäftigte Quartal ${quarter}`).fill('1')
    }
    await profile.getByLabel('Bisher festgestellte Größenklasse').selectOption('MICRO')

    const leaves = createHgbStatementRuleSet('MICRO', 'GKV').lines.filter(line => !createHgbStatementRuleSet('MICRO', 'GKV').lines.some(candidate => candidate.parentId === line.id)).map(line => line.id)
    const required: Array<{ kind: HgbWorkpaperKind; fill: () => Promise<void> }> = [
      { kind: 'OPENING_BALANCE', fill: async () => {
        await this.fill('prior Closing Fingerprint', 'opening-match'); await this.fill('current Opening Fingerprint', 'opening-match'); await this.check('reconciled'); await this.fill('reconciliation Evidence Id', evidenceId)
        const fieldset = this.workpaper().locator('fieldset').filter({ hasText: 'approved Comparative Leaves' })
        for (const lineId of leaves) { await fieldset.getByRole('button', { name: 'Zeile hinzufügen' }).click(); const row = fieldset.locator('.card.panel').last(); await row.getByLabel('line Id').fill(lineId); await row.getByLabel('amount Cents').fill('0') }
      } },
      { kind: 'MAPPING_AND_PRESENTATION', fill: async () => { await this.fill('mapping Version Ids', mappingIds.join(', ')); await this.check('all Posting Accounts Mapped Once'); await this.check('presentation Reviewed'); await this.fill('evidence Id', evidenceId) } },
      { kind: 'RECOGNITION_AND_OWNERSHIP', fill: async () => { const fieldset = this.fieldset('Prüfpositionen'); await fieldset.getByRole('button', { name: 'Zeile hinzufügen' }).click(); const row = fieldset.locator('.card.panel').last(); await row.getByLabel('ID', { exact: true }).fill('revenue-population'); await row.getByLabel('Beschreibung').fill('Revenue and bank population'); await row.getByLabel('ownership Evidence Id').fill(evidenceId); await row.getByLabel('measurement Basis').fill('Nominal amount') } },
      { kind: 'CUT_OFF_AND_ACCRUAL_DEFERRAL', fill: async () => { await this.fill('tested Before Through', `${year}-12-31`); await this.fill('tested After Through', `${nextYear}-01-15`); await this.fill('population Evidence Id', evidenceId); await this.check('exceptions Resolved') } },
      { kind: 'PROVISIONS_AND_CONTINGENCIES', fill: async () => {} },
      { kind: 'RECEIVABLE_AND_MARKET_VALUATION', fill: async () => {} },
      { kind: 'SUBSEQUENT_EVENTS', fill: async () => { await this.fill('search Through', `${nextYear}-02-01`); await this.fill('evidence Id', evidenceId) } },
      { kind: 'GOING_CONCERN', fill: async () => { await this.fill('assessment Through', `${nextYear}-12-31`); await this.fill('forecast Evidence Id', evidenceId); await this.check('going Concern Appropriate') } },
      { kind: 'POLICY_ELECTIONS', fill: async () => { const fieldset = this.fieldset('Wahlrechte'); await fieldset.getByRole('button', { name: 'Zeile hinzufügen' }).click(); const row = fieldset.locator('.card.panel').last(); await row.getByLabel('ID').fill('gkv'); await row.getByLabel('policy').selectOption('TOTAL_COST_PNL'); await row.getByLabel('selected').check(); await row.getByLabel('Begründung').fill('Reviewed total-cost method') } },
      { kind: 'GMBH_EQUITY_AND_RESULT', fill: async () => { await this.fill('result Cents', '100'); await this.check('equity Reconciled'); await this.fill('evidence Id', evidenceId) } },
      { kind: 'MICRO_NOTES_OMISSION', fill: async () => { await this.check('section268 Paragraph7 Disclosed'); await this.check('management Loans Disclosed'); await this.check('additional True And Fair Disclosure Assessed'); await this.fill('evidence Id', evidenceId) } },
      { kind: 'SIZE_AND_APPLICABILITY', fill: async () => { const schedule = this.workpaper().locator('[data-field-key="schedule"]'); const field = (key: string) => schedule.locator(`:scope > .hgb-fields > [data-field-key="${key}"]`); await field('legalForm').locator('select').selectOption(legalForm); await field('establishedSize').locator('select').selectOption('MICRO'); await field('currentFactsEvidenceId').locator('input').fill(evidenceId); await field('priorFactsEvidenceId').locator('input').fill(evidenceId); await field('standaloneNoExemption').locator('input').check(); await field('nonPieUnlistedUnregulated').locator('input').check() } },
    ]
    for (const paper of required) {
      await this.page.getByLabel('Arbeitspapier').selectOption(paper.kind)
      await this.fill('Nachweise', evidenceId)
      await this.fill('Begründung', 'Reviewed against complete evidence population')
      await paper.fill()
      await this.page.getByRole('button', { name: 'Entwurf speichern' }).click()
      await expect(this.page.getByRole('button', { name: 'Als erstellt kennzeichnen' })).toBeVisible()
      await this.page.getByRole('button', { name: 'Als erstellt kennzeichnen' }).click()
      await expect(this.page.getByLabel('Prüfvermerk')).toBeVisible()
    }
  }

  async approvePreparedWorkpapers(year: number, kinds: HgbWorkpaperKind[]) {
    await this.page.goto(`/annual-close/${year}`)
    for (const kind of kinds) {
      await this.page.getByLabel('Arbeitspapier').selectOption(kind)
      await this.page.getByLabel('Prüfvermerk').fill('Independent HGB acceptance review')
      await this.page.getByRole('button', { name: 'Unabhängig freigeben' }).click()
      await expect(this.page.getByRole('button', { name: 'Unabhängig freigeben' })).toBeHidden()
    }
  }

  async evaluateReadyClose(year: number, input: { evidenceId: string; signedAt: string }) {
    await this.page.goto(`/annual-close/${year}`)
    const details = this.page.locator('details').filter({ hasText: '3. Unterschriften, Feststellung und Abschlusslauf' })
    await details.locator('summary').click()
    await details.getByLabel('Vertreter-IDs').fill('director-1')
    await details.getByLabel('Unterschriftnachweis-IDs').fill(input.evidenceId)
    await details.getByLabel('Unterzeichnet am').fill(input.signedAt)
    await details.getByLabel('Gesellschafterbeschluss-ID').fill(input.evidenceId)
    await details.getByLabel('Grund des Abschlusslaufs').fill('Final HGB close acceptance')
    await details.getByRole('button', { name: 'HGB-Abschlusslauf auswerten' }).click()
    await expect(this.page.getByText('READY_TO_LOCK', { exact: true })).toBeVisible()
  }

  private workpaper() { return this.page.locator('details').filter({ hasText: '2. Arbeitspapiere und Bewertung' }) }
  private fieldset(legend: string) { return this.workpaper().locator('fieldset').filter({ has: this.page.getByText(legend, { exact: true }) }) }
  private async fill(label: string, value: string) { await this.workpaper().getByLabel(label, { exact: true }).first().fill(value) }
  private async select(label: string, value: string) { await this.workpaper().getByLabel(label, { exact: true }).first().selectOption(value) }
  private async check(label: string) { await this.workpaper().getByLabel(label, { exact: true }).first().check() }

  async expectHgbCloseBlocked2026() {
    await this.page.goto('/annual-close/2026')
    await expect(this.page.getByText('A current HGB close run with READY_TO_LOCK status is required.')).toBeVisible()
    await this.expectStatement('Assets', '119,00')
    await this.expectStatement('Revenue', '119,00')
    await this.expectStatement('Annual result', '119,00')

    await expect(this.page.getByRole('button', { name: 'Review & lock' })).toBeDisabled()
  }

  async lockReadyFiscalYear(year: number) {
    await this.page.goto(`/annual-close/${year}`)
    await expect(this.page.getByText('READY_TO_LOCK', { exact: false })).toBeVisible()
    const button = this.page.getByRole('button', { name: 'Review & lock' })
    await expect(button).toBeEnabled()
    this.page.once('dialog', dialog => dialog.accept())
    await button.click()
    await expect(this.page.locator('.page-heading .status')).toContainText('Locked')
  }

  private async selectAccount(row: number, account: string) {
    await this.page.getByRole('combobox', { name: `Account row ${row}` }).press('Enter')
    await this.page.getByRole('option', { name: account, exact: true }).click()
  }

  private async expectStatement(label: string, value: string) {
    const statement = this.page.locator('.statement-preview dl > div').filter({
      has: this.page.locator('dt', { hasText: label }),
    })
    await expect(statement).toContainText(value)
  }
}
