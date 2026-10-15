import { readFileSync } from 'node:fs'
const messages = JSON.parse(readFileSync(new URL('../messages/en.json', import.meta.url), 'utf8')) as typeof import('../messages/en.json')
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
    const initialYearLoaded = this.page.waitForResponse(response => response.url().includes(`/api/booking-records?year=${year}`) && response.request().method() === 'GET' && response.ok())
    await this.page.goto(`/bookings?year=${year}`)
    await initialYearLoaded
    await expect(this.page.getByRole('spinbutton', { name: 'Fiscal year', exact: true })).toHaveValue(String(year))
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
    await this.page.getByRole('button', { name: messages.Workspaces.post, exact: true }).click()
    await expect(this.page.getByRole('status')).toContainText(messages.Workspaces.postingSaved)
    await this.page.goto(`/booking-batches?year=${year}`)
    await this.page.getByRole('option', { name: /Revenue for annual close/ }).click()
    await this.page.getByLabel(messages.BookingBatches.postReason).fill('Synthetic annual-close fixture')
    const posted = this.page.waitForResponse(response => response.url().includes('/api/booking-batches/') && response.url().endsWith('/post') && response.request().method() === 'POST')
    await this.page.getByRole('button', { name: messages.BookingBatches.postToJournal, exact: true }).click()
    const response = await posted
    expect(response.ok(), await response.text()).toBe(true)
    await expect(this.page.getByRole('status')).toContainText(messages.BookingBatches.posted)
    return (uploadBody.data ?? uploadBody).id as string
  }

  async prepareSupportedMicroClose(input: { year: number; legalForm: 'UG' | 'GMBH'; evidenceId: string; mappingIds: string[]; ug?: { capitalAccountId: string; carryforwardAccountId: string; reserveAccountId: string; openingFingerprint: string } }) {
    const { year, legalForm, evidenceId, mappingIds } = input
    const nextYear = year + 1
    await this.page.goto(`/annual-close/${year}`)
    const profile = this.page.locator('details').filter({ hasText: '1. Company profile and size facts' })
    await profile.locator('summary').click()
    await profile.getByLabel('Legal form').selectOption(legalForm)
    await profile.getByLabel('Group status').selectOption('STANDALONE_NO_EXEMPTION')
    for (const [label, value] of [
      ['Registered in Germany', 'true'], ['Public-interest entity', 'false'], ['Capital-market oriented or listed', 'false'], ['Regulated industry', 'false'],
      ['Liquidation or insolvency basis', 'false'], ['Going concern is appropriate', 'true'], ['Formed or converted in the fiscal year', 'false'], ['GmbHG § 5a applies', input.ug ? 'true' : 'false'],
      ['Inventory exists', 'false'], ['Fixed assets exist', 'false'], ['Disclosures under § 268 (7) included below the balance sheet', 'true'],
      [messages.HgbCloseWorkbench.profile.managementLoans, 'true'], ['Additional disclosures needed for a true-and-fair view assessed', 'true'],
    ] as const) await profile.getByLabel(label).selectOption(value)
    for (const legend of ['Current fiscal year', 'Prior year']) {
      const facts = profile.locator('fieldset').filter({ has: this.page.getByText(legend, { exact: true }) })
      await facts.getByLabel('Balance-sheet total (cents)').fill(input.ug ? (legend === 'Current fiscal year' ? '101900' : '90000') : (legend === 'Current fiscal year' ? '11900' : '0'))
      await facts.getByLabel('Revenue (cents)').fill(legend === 'Current fiscal year' ? '11900' : '0')
      for (let quarter = 1; quarter <= 4; quarter++) await facts.getByLabel(`Employees in quarter ${quarter}`).fill(input.ug ? '0' : '1')
    }
    await profile.getByLabel('Established prior size').selectOption('MICRO')

    const leaves = createHgbStatementRuleSet('MICRO', 'GKV').lines.filter(line => !createHgbStatementRuleSet('MICRO', 'GKV').lines.some(candidate => candidate.parentId === line.id)).map(line => line.id)
    const required: Array<{ kind: HgbWorkpaperKind; fill: () => Promise<void> }> = [
      { kind: 'OPENING_BALANCE', fill: async () => {
        await this.fill('Prior closing fingerprint', input.ug?.openingFingerprint ?? 'opening-match'); await this.fill('Current opening fingerprint', input.ug?.openingFingerprint ?? 'opening-match'); await this.check('Reconciled'); await this.fill('Reconciliation evidence ID', evidenceId)
        const fieldset = this.workpaper().locator('fieldset').filter({ hasText: 'Approved comparative leaves' })
        for (const lineId of leaves) { await fieldset.getByRole('button', { name: 'Add row' }).click(); const row = fieldset.locator('.card.panel').last(); await row.getByLabel('Line ID').fill(lineId); await row.getByLabel('Amount (cents)').fill(input.ug && ['BS.A.B', 'BS.P.A'].includes(lineId) ? '90000' : '0') }
      } },
      { kind: 'MAPPING_AND_PRESENTATION', fill: async () => { await this.fill('Mapping version IDs', mappingIds.join(', ')); await this.check('All posting accounts mapped once'); await this.check('Presentation reviewed'); await this.fill('Evidence ID', evidenceId) } },
      { kind: 'RECOGNITION_AND_OWNERSHIP', fill: async () => { const fieldset = this.fieldset('Assessed items'); await fieldset.getByRole('button', { name: 'Add row' }).click(); const row = fieldset.locator('.card.panel').last(); await row.getByLabel('ID', { exact: true }).fill('revenue-population'); await row.getByLabel('Description').fill('Revenue and bank population'); await row.getByLabel('Ownership evidence ID').fill(evidenceId); await row.getByLabel('Measurement basis').fill('Nominal amount') } },
      { kind: 'CUT_OFF_AND_ACCRUAL_DEFERRAL', fill: async () => { await this.fill('Tested through before period end', `${year}-12-31`); await this.fill('Tested through after period end', `${nextYear}-01-15`); await this.fill('Population evidence ID', evidenceId); await this.check('Exceptions resolved') } },
      { kind: 'PROVISIONS_AND_CONTINGENCIES', fill: async () => {} },
      { kind: 'RECEIVABLE_AND_MARKET_VALUATION', fill: async () => {} },
      { kind: 'SUBSEQUENT_EVENTS', fill: async () => { await this.fill('Search through', `${nextYear}-02-01`); await this.fill('Evidence ID', evidenceId) } },
      { kind: 'GOING_CONCERN', fill: async () => { await this.fill('Assessment through', `${nextYear}-12-31`); await this.fill('Forecast evidence ID', evidenceId); await this.check('Going-concern assessment appropriate') } },
      { kind: 'POLICY_ELECTIONS', fill: async () => { const fieldset = this.fieldset('Policy elections'); await fieldset.getByRole('button', { name: 'Add row' }).click(); const row = fieldset.locator('.card.panel').last(); await row.getByLabel('ID').fill('gkv'); await row.getByRole('combobox', { name: 'Policy', exact: true }).selectOption('TOTAL_COST_PNL'); await row.getByLabel('Selected').check(); await row.getByLabel('Rationale').fill('Reviewed total-cost method') } },
      { kind: 'GMBH_EQUITY_AND_RESULT', fill: async () => { await this.fill('Result (cents)', '11900'); await this.check('Equity reconciled'); await this.fill('Evidence ID', evidenceId); if (input.ug) await this.fillUgEquity(input.ug, evidenceId) } },
      { kind: 'MICRO_NOTES_OMISSION', fill: async () => { await this.check('§ 268 (7) disclosures below balance sheet'); await this.check('Management loans disclosed below balance sheet'); await this.check('Additional true-and-fair disclosures assessed'); await this.fill('Evidence ID', evidenceId) } },
      { kind: 'SIZE_AND_APPLICABILITY', fill: async () => { const schedule = this.workpaper().locator('[data-field-key="schedule"]'); const field = (key: string) => schedule.locator(`:scope > .hgb-fields > [data-field-key="${key}"]`); await field('legalForm').locator('select').selectOption(legalForm); await field('establishedSize').locator('select').selectOption('MICRO'); await field('currentFactsEvidenceId').locator('input').fill(evidenceId); await field('priorFactsEvidenceId').locator('input').fill(evidenceId); await field('standaloneNoExemption').locator('input').check(); await field('nonPieUnlistedUnregulated').locator('input').check() } },
    ]
    for (const paper of required) {
      await this.page.getByLabel('Workpaper type').selectOption(paper.kind)
      await this.fill('Evidence references', evidenceId)
      await this.fill('Rationale', 'Reviewed against complete evidence population')
      await paper.fill()
      await this.page.getByRole('button', { name: 'Save draft' }).click()
      await expect(this.page.getByRole('button', { name: 'Mark as prepared' })).toBeVisible()
      await this.page.getByRole('button', { name: 'Mark as prepared' }).click()
      await expect(this.page.getByLabel('Review note')).toBeVisible()
    }
  }

  async approvePreparedWorkpapers(year: number, kinds: HgbWorkpaperKind[], selfReview = false) {
    await this.page.goto(`/annual-close/${year}`)
    for (const kind of kinds) {
      await this.page.getByLabel('Workpaper type').selectOption(kind)
      await this.page.getByLabel('Review note').fill(selfReview ? 'I personally rechecked the synthetic evidence, estimates and calculation as sole owner.' : 'Independent HGB acceptance review')
      const reviewed = this.page.waitForResponse(response => response.url().endsWith('/review') && response.request().method() === 'POST')
      await this.page.getByRole('button', { name: selfReview ? messages.HgbReviewPolicy.approveSelf : 'Approve independently' }).click()
      const response = await reviewed
      expect(response.ok(), await response.text()).toBe(true)
      await expect(this.page.getByLabel('Workpaper type').locator(`option[value="${kind}"]`)).toContainText('Reviewed')
    }
  }

  private async fillUgEquity(accounts: { capitalAccountId: string; carryforwardAccountId: string; reserveAccountId: string }, evidenceId: string) {
    const f = messages.HgbCloseWorkbench.fields
    await this.fill(f.shareCapitalCents, '100000')
    await this.check(f.section5aReserveApplicable)
    await this.fill(f.reserveCalculationEvidenceId, evidenceId)
    for (const [key, value] of Object.entries({ ...accounts, priorLossCarryforwardCents: '10000', priorProfitCarryforwardCents: '0', priorStatutoryReserveCents: '0', reserveAllocationCents: '475', distributionCents: '0', carryforwardCents: '1425', priorCarryforwardEvidenceId: evidenceId, resolutionEvidenceId: evidenceId, reserveProposalId: 'ug-reserve-2026' })) {
      if (key === 'openingFingerprint') continue
      await this.fill(f[key as keyof typeof f], String(value))
    }
    await this.fill(f.proposalIds, 'ug-reserve-2026')
    const adjustments = this.fieldset(f.adjustments)
    await adjustments.getByRole('button', { name: /^Add row:/ }).click()
    const row = adjustments.locator(':scope > .card.panel').last()
    await row.getByLabel(f.id, { exact: true }).fill('ug-reserve-2026')
    await row.getByLabel(f.bookingDate, { exact: true }).fill('2026-12-31')
    await row.getByLabel(f.description, { exact: true }).fill('UG statutory reserve after commercial loss carryforward')
    await row.getByLabel(f.evidenceIds, { exact: true }).fill(evidenceId)
    const lines = row.locator('fieldset').filter({ has: this.page.getByText(f.lines, { exact: true }) })
    for (const [accountId, debit, credit] of [[accounts.carryforwardAccountId, '475', '0'], [accounts.reserveAccountId, '0', '475']]) {
      await lines.getByRole('button', { name: /^Add row:/ }).click()
      const line = lines.locator('.card.panel').last()
      await line.getByLabel(f.accountId, { exact: true }).fill(accountId)
      await line.getByLabel(f.debitCents, { exact: true }).fill(debit)
      await line.getByLabel(f.creditCents, { exact: true }).fill(credit)
    }
  }

  async selectOwnerReviewPolicy(evidenceId: string) {
    const panel = this.page.getByTestId('hgb-review-policy')
    await panel.locator('summary').click()
    await panel.getByLabel(messages.HgbReviewPolicy.method).selectOption('OWNER_SELF_REVIEW')
    await panel.getByLabel(messages.HgbReviewPolicy.soleOwner).check()
    await panel.getByLabel(messages.HgbReviewPolicy.noExtraReview).check()
    await panel.getByLabel(messages.HgbReviewPolicy.reason).fill('Single-person synthetic UG: register, articles and obligations checked.')
    await panel.getByLabel(messages.HgbReviewPolicy.evidence).fill(evidenceId)
    await panel.getByRole('button', { name: messages.HgbReviewPolicy.save }).click()
    await expect(panel.locator('summary')).toContainText(messages.HgbReviewPolicy.self)
  }

  async postUgReserve() {
    await this.page.getByLabel('Workpaper type').selectOption('GMBH_EQUITY_AND_RESULT')
    const posted = this.page.waitForResponse(response => response.url().includes('/adjustments/') && response.url().endsWith('/post') && response.request().method() === 'POST')
    await this.page.getByRole('button', { name: /Post adjustment/ }).click()
    const response = await posted
    expect(response.ok(), await response.text()).toBe(true)
    await expect(this.page.locator('.hgb-workbench')).toHaveAttribute('aria-busy', 'false')
    await expect(this.page.getByLabel('Workpaper type').locator('option[value="GMBH_EQUITY_AND_RESULT"]')).toContainText('Reviewed')
    await this.page.getByLabel('Workpaper type').selectOption('GMBH_EQUITY_AND_RESULT')
    await expect(this.workpaper().getByLabel('Title', { exact: true })).toHaveValue(messages.HgbCloseWorkbench.kinds.GMBH_EQUITY_AND_RESULT)
    await expect(this.workpaper().getByLabel(messages.HgbCloseWorkbench.fields.reserveAllocationCents, { exact: true })).toHaveValue('475')
    await expect(this.page.getByRole('button', { name: /Post adjustment/ })).toBeHidden()
  }

  async evaluateReadyClose(year: number, input: { evidenceId: string; signedAt: string; representativeId?: string }) {
    await this.page.goto(`/annual-close/${year}`)
    const details = this.page.locator('details').filter({ hasText: '3. Signatures, annual-accounts adoption and close run' })
    await details.locator('summary').click()
    const representative = details.getByLabel('Legal representative IDs')
    if (await representative.isEditable()) await representative.fill(input.representativeId ?? 'director-1')
    else await expect(representative).toHaveValue(input.representativeId!)
    await details.getByLabel('Signature-evidence IDs').fill(input.evidenceId)
    await details.getByLabel('Signed at').fill(input.signedAt)
    await details.getByLabel('Shareholder resolution ID').fill(input.evidenceId)
    await details.getByLabel('Close-run reason').fill('Final HGB close acceptance')
    await details.getByRole('button', { name: 'Evaluate HGB close run' }).click()
    await expect(this.page.locator('.hgb-workbench .panel-title').getByText(messages.HgbCloseWorkbench.status.READY_TO_LOCK, { exact: true })).toBeVisible()
  }

  private workpaper() { return this.page.locator('details').filter({ hasText: '2. Workpapers and assessment' }) }
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
    await expect(this.page.locator('.hgb-workbench .panel-title').getByText(messages.HgbCloseWorkbench.status.READY_TO_LOCK, { exact: true })).toBeVisible()
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
