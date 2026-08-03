import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test, expect } from '@playwright/test'
import { AnnualClosePage } from './annual-close-page'
import { createHgbStatementRuleSet } from '../src/core/hgbStatements'
import { HGB_WORKPAPER_KINDS, type HgbCloseProfile } from '../src/core/hgbClose'
import type { HgbWorkpaperDraft } from '../src/core/hgbWorkpapers'

const invoicePdf = readFileSync(new URL('./fixtures/invoice.pdf', import.meta.url))

test.describe('real annual close', () => {
  test.setTimeout(120_000)

  test('fails closed when an expired ledger has no current statutory HGB run', async ({ browser }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL as string
    const context = await browser.newContext({ baseURL })
    await context.addCookies([{ name: 'NEXT_LOCALE', value: 'en', url: baseURL }])
    const page = await context.newPage()
    const email = `annual-close-${randomUUID()}@example.test`
    const signUp = await page.request.post('/api/auth/sign-up/email', {
      headers: { Origin: baseURL },
      data: { name: 'Annual Close E2E', email, password: 'Annual-close-password-2026!' },
    })
    expect(signUp.ok(), `${signUp.status()} ${await signUp.text()}`).toBe(true)

    const annualClose = new AnnualClosePage(page)
    await annualClose.createExpiredShortFiscalYear2026()
    await annualClose.postRevenueWithEvidence(invoicePdf)

    const beforeCloseResponse = await page.request.get('/api/booking-records?year=2026')
    expect(beforeCloseResponse.ok()).toBe(true)
    const beforeClose = await beforeCloseResponse.json()
    expect(beforeClose).toMatchObject({
      fiscalYear: { year: 2026, status: 'OPEN' },
      statements: {
        assetsCents: 11900,
        revenueCents: 11900,
        netIncomeCents: 11900,
        balanceDifferenceCents: 0,
      },
    })
    expect(beforeClose.entries).toHaveLength(1)

    await annualClose.expectHgbCloseBlocked2026()
    const rejected = await page.request.post('/api/fiscal-years/2026/close')
    expect(rejected.status()).toBe(400)
    expect((await rejected.json()).issues.join(' ')).toMatch(/READY_TO_LOCK HGB close run/)
    const unchanged = await (await page.request.get('/api/booking-records?year=2026')).json()
    expect(unchanged.fiscalYear).toMatchObject({ year: 2026, status: 'OPEN', lockedAt: null })
    expect(unchanged.entries).toHaveLength(1)
    expect(unchanged.statements).toEqual(beforeClose.statements)

    await context.close()
  })

  test('completes the reviewed HGB close, E-Bilanz export, KSt and GewSt lifecycle for a 2025 UG', async ({ browser }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL as string
    const ownerContext = await browser.newContext({ baseURL }); await ownerContext.addCookies([{ name: 'NEXT_LOCALE', value: 'en', url: baseURL }]); const ownerPage = await ownerContext.newPage()
    const reviewerContext = await browser.newContext({ baseURL }); const reviewerPage = await reviewerContext.newPage()
    const password = 'Annual-close-password-2026!'
    const signup = async (page: typeof ownerPage, role: string) => {
      const response = await page.request.post('/api/auth/sign-up/email', { headers: { Origin: baseURL }, data: { name: role, email: `${role.toLowerCase().replaceAll(' ', '-')}-${randomUUID()}@example.test`, password } })
      expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(true)
      const overview = await api(page, 'get', '/api/compliance')
      return overview.tenantId as string
    }
    const ownerId = await signup(ownerPage, 'HGB owner'); const reviewerId = await signup(reviewerPage, 'HGB reviewer')
    await api(ownerPage, 'post', '/api/compliance', { action: 'policy.configure', operatorIds: [ownerId, reviewerId], allowedStorageRegions: ['DE'], recoveryPointObjectiveMinutes: 60, recoveryTimeObjectiveMinutes: 60, backupKeyId: 'e2e-hgb-key', reason: 'Independent HGB reviewer' })
    const document = await api(ownerPage, 'post', '/api/documents', invoicePdf, { 'content-type': 'application/pdf', 'x-document-file-name': encodeURIComponent('hgb-close-evidence.pdf') })
    const evidenceId = document.id as string

    const periods = new Map<number, { id: string }>()
    for (const year of [2024, 2025]) periods.set(year, await api(ownerPage, 'post', '/api/compliance', { action: 'period.create', referenceYear: year, label: `HGB ${year}`, startsAt: `${year}-01-01`, endsAt: `${year}-12-31`, reason: 'HGB close acceptance period' }))
    const companyProfile = { companyName: 'HGB E2E UG (haftungsbeschränkt)', registeredAddress: { streetAndHouseNumber: 'Test 1', zipCode: '10115', city: 'Berlin', country: 'DE' }, legalForm: 'UG', registerCourt: 'Berlin', registerNumber: 'HRB 1', taxNumber: '1234567890123', taxOffice: 'Berlin', vatRegime: 'STANDARD', vatFilingFrequency: 'MONTHLY', activity: 'Software', sizeClass: 'MICRO', chart: 'CUSTOM:HGB-MICRO', elections: [], annualTaxProfile: { tradeBusiness: true, establishments: 1, adviserExtension: false, municipalityCode: '11000000', tradeTaxMultiplierBasisPoints: 41000, foreignIncome: false, groupOrConsolidation: false, lossCarry: false, specialRegime: false, withholdingOrCredits: false, payroll: false }, eBilanz: { accountingStandard: 'HGB', incomeStatementMethod: 'GKV', statementType: 'E', reportStatus: 'E', consolidationRange: 'EA', incomeClassification: 'trade' } }
    const mappingInput = { chartId: 'CUSTOM:HGB-MICRO', size: 'MICRO', method: 'GKV', reason: 'Reviewed HGB presentation mapping', evidenceId, mappings: [
      { accountNumber: 1200, name: 'Bank', accountType: 'ASSET', normalBalance: 'DEBIT', presentationSign: 1, hgbPosition: 'BS.A.B', eBilanzPosition: 'bs.ass.currAss.cashEquiv.bank' },
      { accountNumber: 8400, name: 'Revenue', accountType: 'REVENUE', normalBalance: 'CREDIT', presentationSign: 1, hgbPosition: 'IS.M.1', eBilanzPosition: 'is.netIncome.regular.operatingTC.grossTradingProfit.totalOutput' },
    ] }
    const mappingIds: string[] = []
    for (const year of [2024, 2025]) {
      await api(ownerPage, 'post', `/api/fiscal-years/${year}/hgb-close/profile`, { profile: companyProfile, evidenceId, reason: 'Verified company register and master data' })
      const rows = await api(ownerPage, 'post', `/api/fiscal-years/${year}/hgb-close/mappings`, mappingInput) as Array<{ id: string }>; mappingIds.push(...rows.map(row => row.id))
    }
    const workspace = await api(ownerPage, 'get', '/api/booking-records?year=2024')
    const accountId = (number: number) => (workspace.accounts as Array<{ id: string; number: number }>).find(account => account.number === number)!.id
    await api(ownerPage, 'post', '/api/booking-records', { fiscalYear: 2025, bookingDate: '2025-12-15', documentNumber: 'HGB-2025', description: 'HGB revenue 2025', documentIds: [evidenceId], lines: [{ accountId: accountId(1200), debitCents: 100, creditCents: 0 }, { accountId: accountId(8400), debitCents: 0, creditCents: 100 }] })

    const closeProfile: HgbCloseProfile = { ruleSetVersion: 'HGB-DE-2024.1', legalForm: 'UG', fiscalPeriodStart: '2025-01-01', fiscalPeriodEnd: '2025-12-31', germanRegisteredEntity: true, groupStatus: 'STANDALONE_NO_EXEMPTION', publicInterestEntity: false, capitalMarketOrListed: false, regulatedIndustry: false, liquidationOrInsolvencyBasis: false, goingConcern: true, formedOrConvertedInCurrentPeriod: false, currentSizeFacts: { balanceSheetTotalCents: 100, revenueCents: 100, quarterlyEmployeeCounts: [1, 1, 1, 1], microExcludedBySection267a: false }, priorSizeFacts: { balanceSheetTotalCents: 90, revenueCents: 90, quarterlyEmployeeCounts: [1, 1, 1, 1], microExcludedBySection267a: false }, priorEstablishedSize: 'MICRO', hasInventory: false, hasFixedAssets: false, microNotesOmission: { requiredSection268Paragraph7DisclosuresIncludedBelowBalanceSheet: true, advancesAndLoansToManagementDisclosedBelowBalanceSheet: true, requiredAdditionalTrueAndFairDisclosuresIncludedBelowBalanceSheet: true }, section5aApplies: false }
    const prior: Record<string, number> = {}
    const rule = createHgbStatementRuleSet('MICRO', 'GKV'); const approvedComparativeLeaves = rule.lines.filter(line => !rule.lines.some(candidate => candidate.parentId === line.id)).map(line => ({ lineId: line.id, amountCents: prior[line.id] ?? 0 }))
    const base = (kind: typeof HGB_WORKPAPER_KINDS[number], schedule: Record<string, unknown>, conclusion: HgbWorkpaperDraft['conclusion'] = 'COMPLETE'): HgbWorkpaperDraft => ({ kind, title: `Reviewed ${kind}`, conclusion, evidenceIds: [evidenceId], schedule: schedule as unknown as HgbWorkpaperDraft['schedule'], adjustments: [] })
    const applicable = { applicability: 'APPLICABLE', rationale: 'Reviewed against complete evidence population' }
    const notApplicable = (type: string) => ({ type, applicability: 'NOT_APPLICABLE', rationale: 'No applicable balance or transaction population' })
    const papers: HgbWorkpaperDraft[] = [
      base('OPENING_BALANCE', { ...applicable, type: 'OPENING_BALANCE', priorClosingFingerprint: 'opening-match', currentOpeningFingerprint: 'opening-match', reconciled: true, reconciliationEvidenceId: evidenceId, approvedComparativeLeaves }),
      base('MAPPING_AND_PRESENTATION', { ...applicable, type: 'MAPPING_PRESENTATION', mappingVersionIds: mappingIds, allPostingAccountsMappedOnce: true, presentationReviewed: true, evidenceId }),
      base('RECOGNITION_AND_OWNERSHIP', { ...applicable, type: 'RECOGNITION_OWNERSHIP', items: [{ id: 'revenue-population', description: 'Revenue and bank population', recognition: 'RECOGNIZE', ownershipEvidenceId: evidenceId, measurementBasis: 'Nominal amount' }] }),
      base('CUT_OFF_AND_ACCRUAL_DEFERRAL', { ...applicable, type: 'CUT_OFF_ACCRUAL_DEFERRAL', testedBeforeThrough: '2025-12-31', testedAfterThrough: '2026-01-15', populationEvidenceId: evidenceId, exceptionsResolved: true, items: [] }),
      base('PROVISIONS_AND_CONTINGENCIES', { ...applicable, type: 'PROVISION_CONTINGENCY', items: [] }),
      base('RECEIVABLE_AND_MARKET_VALUATION', { ...applicable, type: 'RECEIVABLE_MARKET_VALUATION', items: [] }),
      base('FIXED_ASSETS_AND_DEPRECIATION', notApplicable('FIXED_ASSET_VALUATION'), 'NOT_APPLICABLE'), base('INVENTORY_COUNT_AND_VALUATION', notApplicable('INVENTORY_VALUATION'), 'NOT_APPLICABLE'),
      base('SUBSEQUENT_EVENTS', { ...applicable, type: 'SUBSEQUENT_EVENTS', searchThrough: '2026-02-01', evidenceId, events: [] }),
      base('GOING_CONCERN', { ...applicable, type: 'GOING_CONCERN', assessmentThrough: '2026-12-31', forecastEvidenceId: evidenceId, goingConcernAppropriate: true, materialUncertainty: false }),
      base('POLICY_ELECTIONS', { ...applicable, type: 'POLICY_ELECTIONS', elections: [{ id: 'gkv', policy: 'TOTAL_COST_PNL', selected: true, rationale: 'Reviewed total-cost method', applicable: true }] }),
      base('NOTES', notApplicable('NOTES_QUESTIONNAIRE'), 'NOT_APPLICABLE'),
      base('GMBH_EQUITY_AND_RESULT', { ...applicable, type: 'GMBH_EQUITY_RESULT', shareCapitalCents: 0, resultCents: 100, equityReconciled: true, section5aReserveApplicable: false, evidenceId, proposalIds: [] }),
      base('MICRO_NOTES_OMISSION', { ...applicable, type: 'MICRO_NOTES_OMISSION', section268Paragraph7Disclosed: true, managementLoansDisclosed: true, additionalTrueAndFairDisclosureAssessed: true, evidenceId }),
      base('SIZE_AND_APPLICABILITY', { ...applicable, type: 'SIZE_APPLICABILITY', legalForm: 'UG', establishedSize: 'MICRO', currentFactsEvidenceId: evidenceId, priorFactsEvidenceId: evidenceId, standaloneNoExemption: true, nonPieUnlistedUnregulated: true, closeProfile }),
    ]
    for (const paper of papers) {
      const saved = await api(ownerPage, 'put', '/api/fiscal-years/2025/hgb-close/workpapers', { workpaper: paper })
      await api(ownerPage, 'post', `/api/fiscal-years/2025/hgb-close/workpapers/${saved.id}/prepare`, { expectedChecksum: saved.checksum })
      await api(reviewerPage, 'post', `/api/fiscal-years/2025/hgb-close/workpapers/${saved.id}/review`, { tenantId: ownerId, decision: 'APPROVE', reason: 'Independent HGB acceptance review' })
    }
    const annual = await api(ownerPage, 'post', '/api/compliance', { action: 'reporting.annual.create', fiscalPeriodId: periods.get(2025)!.id, reason: 'Generate reviewed HGB annual accounts' })
    await api(reviewerPage, 'post', '/api/compliance', { tenantId: ownerId, action: 'reporting.package.approve', packageId: annual.id, reason: 'Independent annual accounts approval' })
    const signedAt = new Date().toISOString()
    await api(ownerPage, 'post', '/api/fiscal-years/2025/hgb-close', { reason: 'Final HGB close acceptance', annualAccountsPackageId: annual.id, annualAccountsChecksum: annual.checksum, legalRepresentativeIds: ['director-1'], managingDirectorSignatures: [{ representativeId: 'director-1', signedAt, signatureEvidenceId: evidenceId }], shareholderResolutionId: evidenceId })
    const overview = await api(ownerPage, 'get', '/api/fiscal-years/2025/hgb-close')
    expect(overview.runs[0].status).toBe('READY_TO_LOCK')
    const beforeLock = await api(ownerPage, 'get', '/api/booking-records?year=2025')
    expect(beforeLock.closingIssues).toEqual([])
    await new AnnualClosePage(ownerPage).lockReadyFiscalYear(2025)
    expect((await api(ownerPage, 'get', '/api/booking-records?year=2025')).fiscalYear.status).toBe('CLOSED')
    const rejected = await ownerPage.request.post('/api/booking-records', { data: { fiscalYear: 2025, bookingDate: '2025-12-20', documentNumber: 'LATE', description: 'Must reject', lines: [{ accountId: accountId(1200), debitCents: 1, creditCents: 0 }, { accountId: accountId(8400), debitCents: 0, creditCents: 1 }] } })
    expect(rejected.status()).toBe(400)

    await ownerPage.goto('/e-bilanz/2025')
    await ownerPage.getByLabel('Company name').fill(companyProfile.companyName)
    await ownerPage.getByLabel('Street and house number').fill('Test 1')
    await ownerPage.getByLabel('Postal code').fill('10115')
    await ownerPage.getByLabel('City').fill('Berlin')
    await ownerPage.getByLabel('13-digit ELSTER tax number').fill('1234567890123')
    await ownerPage.getByLabel('Legal form').selectOption('UG')
    const download = ownerPage.waitForEvent('download')
    await ownerPage.getByRole('button', { name: 'Create XBRL validation package' }).click()
    expect((await download).suggestedFilename()).toBe('e-bilanz-2025-pruefpaket.zip')
    await expect(ownerPage.getByText(/v1 · EXPORTED/)).toBeVisible()

    for (const kind of ['KST', 'GEWST'] as const) {
      await ownerPage.goto('/tax/2025')
      await expect(ownerPage.getByText(/Local lifecycle emulator/)).toBeVisible()
      await ownerPage.getByLabel('Form').selectOption(kind)
      await ownerPage.getByRole('button', { name: 'Validate officially' }).click()
      await expect(ownerPage.getByText('The official gateway validated the dataset.')).toBeVisible()
      await expect(ownerPage.getByText(/Finanzamt assessment is authoritative/).first()).toBeVisible()
      await ownerPage.getByLabel('I explicitly approve this binding transmission.').check()
      await ownerPage.getByRole('button', { name: 'Submit binding' }).click()
      await expect(ownerPage.getByRole('cell', { name: `e2e-${kind.toLowerCase()}-2025-receipt` })).toBeVisible()
    }
    await ownerPage.goto('/tax/2025')
    await ownerPage.getByLabel('Accepted declaration').selectOption({ label: 'KST · 2025' })
    await ownerPage.getByLabel('Notice ID').fill('KST-2025-E2E-1')
    await ownerPage.getByLabel('Assessed amount (cents)').fill('42')
    await ownerPage.getByLabel('Received on').fill(new Date().toISOString().slice(0, 10))
    await ownerPage.getByLabel('Evidence document ID').fill(evidenceId)
    await ownerPage.getByRole('button', { name: 'Record authoritative assessment' }).click()
    await expect(ownerPage.getByText('Authoritative Finanzamt assessment recorded and reconciled.')).toBeVisible()
    await expect(ownerPage.getByRole('cell', { name: 'KST-2025-E2E-1' })).toBeVisible()
    await ownerPage.reload()
    await expect(ownerPage.getByRole('cell', { name: 'KST-2025-E2E-1' })).toBeVisible()
    await ownerContext.close(); await reviewerContext.close()
  })
})

async function api(page: import('@playwright/test').Page, method: 'get' | 'post' | 'put', url: string, data?: unknown, headers?: Record<string, string>) {
  const response = await page.request[method](url, method === 'get' ? undefined : { data, headers })
  if (!response.ok()) throw new Error(`${method.toUpperCase()} ${url}: ${response.status()} ${await response.text()}`)
  const body = await response.json()
  return body.data ?? body
}
