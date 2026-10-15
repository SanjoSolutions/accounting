import { expect, type Page, type TestInfo } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import type { HgbWorkpaperDraft } from '../src/core/hgbWorkpapers'
import type { HgbCloseProfile } from '../src/core/hgbClose'
import { createHgbStatementRuleSet } from '../src/core/hgbStatements'

export class AnnualDocumentPage {
  constructor(private readonly page: Page) {}

  /** Real persisted workpapers; no network mocks or direct database writes. */
  async prepareDocumentClose(year: number, evidenceId: string, mappingIds: string[], reviewer: Page) {
    const endpoint = `/api/fiscal-years/${year}/hgb-close/workpapers`
    const profile: HgbCloseProfile = {
      ruleSetVersion: 'HGB-DE-2024.1', legalForm: 'UG', fiscalPeriodStart: `${year}-01-01`, fiscalPeriodEnd: `${year}-12-31`, germanRegisteredEntity: true,
      groupStatus: 'STANDALONE_NO_EXEMPTION', publicInterestEntity: false, capitalMarketOrListed: false, regulatedIndustry: false, liquidationOrInsolvencyBasis: false, goingConcern: true, formedOrConvertedInCurrentPeriod: false,
      currentSizeFacts: { balanceSheetTotalCents: 11900, revenueCents: 11900, quarterlyEmployeeCounts: [1, 1, 1, 1], microExcludedBySection267a: false },
      priorSizeFacts: { balanceSheetTotalCents: 0, revenueCents: 0, quarterlyEmployeeCounts: [1, 1, 1, 1], microExcludedBySection267a: false }, priorEstablishedSize: 'MICRO', hasInventory: false, hasFixedAssets: false, section5aApplies: true,
      microNotesOmission: { requiredSection268Paragraph7DisclosuresIncludedBelowBalanceSheet: true, advancesAndLoansToManagementDisclosedBelowBalanceSheet: true, requiredAdditionalTrueAndFairDisclosuresIncludedBelowBalanceSheet: true },
    }
    const base = { applicability: 'APPLICABLE' as const, rationale: 'Reviewed synthetic evidence population' }
    const lines = createHgbStatementRuleSet('MICRO', 'GKV').lines
    const draft = (kind: HgbWorkpaperDraft['kind'], schedule: HgbWorkpaperDraft['schedule']): HgbWorkpaperDraft => ({ kind, title: kind, conclusion: 'COMPLETE', evidenceIds: [evidenceId], adjustments: [], schedule })
    const workpapers: HgbWorkpaperDraft[] = [
      draft('OPENING_BALANCE', { ...base, type: 'OPENING_BALANCE', priorClosingFingerprint: 'zero-opening', currentOpeningFingerprint: 'zero-opening', reconciled: true, reconciliationEvidenceId: evidenceId, approvedComparativeLeaves: lines.filter(line => !lines.some(child => child.parentId === line.id)).map(line => ({ lineId: line.id, amountCents: 0 })) }),
      draft('MAPPING_AND_PRESENTATION', { ...base, type: 'MAPPING_PRESENTATION', mappingVersionIds: mappingIds, allPostingAccountsMappedOnce: true, presentationReviewed: true, evidenceId }),
      draft('RECOGNITION_AND_OWNERSHIP', { ...base, type: 'RECOGNITION_OWNERSHIP', items: [{ id: 'revenue-bank', description: 'Synthetic revenue and bank', recognition: 'RECOGNIZE', ownershipEvidenceId: evidenceId, measurementBasis: 'Nominal amount' }] }),
      draft('CUT_OFF_AND_ACCRUAL_DEFERRAL', { ...base, type: 'CUT_OFF_ACCRUAL_DEFERRAL', testedBeforeThrough: `${year}-12-31`, testedAfterThrough: `${year + 1}-01-15`, populationEvidenceId: evidenceId, exceptionsResolved: true, items: [] }),
      draft('PROVISIONS_AND_CONTINGENCIES', { ...base, type: 'PROVISION_CONTINGENCY', items: [] }),
      draft('RECEIVABLE_AND_MARKET_VALUATION', { ...base, type: 'RECEIVABLE_MARKET_VALUATION', items: [] }),
      draft('SUBSEQUENT_EVENTS', { ...base, type: 'SUBSEQUENT_EVENTS', searchThrough: `${year + 1}-03-03`, evidenceId, events: [] }),
      draft('GOING_CONCERN', { ...base, type: 'GOING_CONCERN', assessmentThrough: `${year + 1}-12-31`, forecastEvidenceId: evidenceId, goingConcernAppropriate: true, materialUncertainty: false }),
      draft('POLICY_ELECTIONS', { ...base, type: 'POLICY_ELECTIONS', elections: [{ id: 'gkv', policy: 'TOTAL_COST_PNL', selected: true, applicable: true, rationale: 'Gesamtkostenverfahren' }] }),
      draft('GMBH_EQUITY_AND_RESULT', { ...base, type: 'GMBH_EQUITY_RESULT', resultCents: 11900, shareCapitalCents: 0, equityReconciled: true, section5aReserveApplicable: true, reserveCalculationEvidenceId: evidenceId, evidenceId, proposalIds: [] }),
      draft('MICRO_NOTES_OMISSION', { ...base, type: 'MICRO_NOTES_OMISSION', section268Paragraph7Disclosed: true, managementLoansDisclosed: true, additionalTrueAndFairDisclosureAssessed: true, evidenceId }),
      draft('SIZE_AND_APPLICABILITY', { ...base, type: 'SIZE_APPLICABILITY', legalForm: 'UG', establishedSize: 'MICRO', currentFactsEvidenceId: evidenceId, priorFactsEvidenceId: evidenceId, standaloneNoExemption: true, nonPieUnlistedUnregulated: true, closeProfile: profile }),
    ]
    const notes: HgbWorkpaperDraft = {
      kind: 'NOTES', title: 'Below-balance-sheet disclosures', conclusion: 'COMPLETE', evidenceIds: [evidenceId], adjustments: [],
      schedule: { type: 'NOTES_QUESTIONNAIRE', applicability: 'APPLICABLE', rationale: 'Explicit required micro disclosures', notesRequired: true, questions: [
        { id: 'liabilities', required: true, answer: 'YES', evidenceId, disclosureText: 'Haftungsverhältnisse nach § 268 Abs. 7 HGB bestehen nicht.' },
        { id: 'loans', required: true, answer: 'YES', evidenceId, disclosureText: 'Vorschüsse und Kredite an Mitglieder der Geschäftsführung bestehen nicht.' },
        { id: 'private', required: false, answer: 'YES', disclosureText: 'PRIVATE GuV: Einzelkundenanalyse.' },
      ] },
    }
    for (const workpaper of [...workpapers, notes]) {
      const saved = await this.page.request.put(endpoint, { data: { workpaper } }); expect(saved.ok(), await saved.text()).toBeTruthy()
      const { data: record } = await saved.json()
      const prepared = await this.page.request.post(`${endpoint}/${record.id}/prepare`, { data: { expectedChecksum: record.checksum } }); expect(prepared.ok(), await prepared.text()).toBeTruthy()
      const reviewed = await reviewer.request.post(`${endpoint}/${record.id}/review`, { data: { decision: 'APPROVE', reason: 'Independent synthetic export review' } }); expect(reviewed.ok(), await reviewed.text()).toBeTruthy()
    }
  }

  async evaluateClose(year: number, packageId: string, evidenceId: string) {
    const packages = (await (await this.page.request.get('/api/compliance?view=reporting')).json()).data.packages
    const source = packages.find((item: { id: string }) => item.id === packageId)
    const response = await this.page.request.post(`/api/fiscal-years/${year}/hgb-close`, { data: { annualAccountsPackageId: packageId, annualAccountsChecksum: source.checksum, legalRepresentativeIds: ['director-test'], managingDirectorSignatures: [{ representativeId: 'director-test', signedAt: `${year + 1}-03-03T11:00:00Z`, signatureEvidenceId: evidenceId }], shareholderResolutionId: evidenceId, reason: 'Exact document export fixture close' } })
    expect(response.ok(), await response.text()).toBeTruthy()
    expect((await response.json()).data.status).toBe('READY_TO_LOCK')
  }

  async exportAndInspect(packageId: string, testInfo: TestInfo) {
    await this.page.goto('/compliance')
    const section = this.page.getByRole('region', { name: 'Jahresabschluss herunterladen' })
    await section.getByLabel('Freigegebene Abschlussversion').selectOption(packageId)
    const exported = this.page.waitForResponse(response => response.url().endsWith(`/packages/${packageId}/documents`) && response.request().method() === 'POST')
    await section.getByRole('button', { name: 'Vollständigen Jahresabschluss exportieren' }).click()
    const response = await exported; expect(response.ok(), await response.text()).toBeTruthy()
    await expect(section.getByRole('link', { name: 'Druckansicht öffnen' })).toBeVisible()
    const popup = this.page.waitForEvent('popup')
    await section.getByRole('link', { name: 'Druckansicht öffnen' }).click()
    const print = await popup
    expect(new URL(print.url()).port).toBe('3113')
    await expect(print.getByRole('heading', { name: 'Jahresabschluss 2026', exact: true })).toBeVisible()
    await expect(print.getByRole('heading', { name: 'Gewinn- und Verlustrechnung', exact: true })).toBeVisible()
    await expect(print.locator('body')).toContainText('119,00')
    await print.screenshot({ path: testInfo.outputPath('annual-screen.png'), fullPage: true })
    await print.pdf({ path: testInfo.outputPath('annual-print.pdf'), format: 'A4', printBackground: true, preferCSSPageSize: true })
    await print.close()
    await section.getByText('Manuelles Paket für das Unternehmensregister', { exact: true }).click()
    await section.getByLabel('Haftungsverhältnisse nach § 268 Abs. 7 HGB bestehen nicht.', { exact: true }).check()
    await section.getByLabel('Vorschüsse und Kredite an Mitglieder der Geschäftsführung bestehen nicht.', { exact: true }).check()
    await section.getByLabel('Feststellungsdatum laut Gesellschafterbeschluss').fill('2027-03-03')
    await section.getByLabel('Die Auswahl enthält sämtliche erforderlichen Angaben', { exact: false }).check()
    const manualExport = this.page.waitForResponse(res => res.url().endsWith(`/packages/${packageId}/documents`) && res.request().method() === 'POST')
    await section.getByRole('button', { name: 'Minimiertes Einreichungspaket exportieren' }).click()
    const manualResponse = await manualExport; expect(manualResponse.ok(), await manualResponse.text()).toBeTruthy()
    const artifact = (await manualResponse.json()).data
    const url = `/api/compliance/packages/${packageId}/documents?artifactId=${artifact.id}&file=einreichung.html`
    const document = await this.page.request.get(url)
    expect(document.headers()['cache-control']).toBe('private, no-store')
    const html = await document.text(); expect(html).not.toContain('PRIVATE'); expect(html).not.toContain('Gewinn- und Verlustrechnung')
    const manualPage = await this.page.context().newPage()
    await manualPage.goto(url)
    await expect(manualPage.getByRole('heading', { name: 'Bilanz zur Hinterlegung 2026' })).toBeVisible()
    await manualPage.screenshot({ path: testInfo.outputPath('manual-screen.png'), fullPage: true })
    await manualPage.pdf({ path: testInfo.outputPath('manual-print.pdf'), format: 'A4', printBackground: true, preferCSSPageSize: true })
    await manualPage.setViewportSize({ width: 390, height: 844 }); await manualPage.screenshot({ path: testInfo.outputPath('manual-mobile.png'), fullPage: true })
    await manualPage.close()
    const bundle = await this.page.request.get(`/api/compliance/packages/${packageId}/documents?artifactId=${artifact.id}`)
    expect(bundle.headers()['content-type']).toBe('application/zip')
    await writeFile(testInfo.outputPath('manual-export.zip'), await bundle.body())
    await section.screenshot({ path: testInfo.outputPath('export-ui.png') })
  }
}
