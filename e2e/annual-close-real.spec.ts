import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test, expect } from '@playwright/test'
import { AnnualClosePage } from './annual-close-page'
import { HGB_WORKPAPER_KINDS } from '../src/core/hgbClose'
import { TaxWorkflowPage } from './tax-workflow-page'
import { EBalancePage } from './e-balance-page'
import { AuthenticationPage } from './pages'
import { AccessPage, ComplianceSetupPage } from './compliance-setup-page'

const invoicePdf = readFileSync(new URL('./fixtures/invoice.pdf', import.meta.url))

test.use({ actionTimeout: 10_000 })

test.describe('real annual close', () => {
  test.setTimeout(600_000)

  test('fails closed when an expired ledger has no current statutory HGB run', async ({ browser }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL as string
    const context = await browser.newContext({ baseURL })
    await context.addCookies([{ name: 'NEXT_LOCALE', value: 'en', url: baseURL }])
    const page = await context.newPage()
    const email = `annual-close-${randomUUID()}@example.test`
    await page.goto('/sign-up')
    await new AuthenticationPage(page).signUp('Annual Close E2E', email, 'Annual-close-password-2026!')
    await expect(page).toHaveURL('/')

    const annualClose = new AnnualClosePage(page)
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

  for (const scenario of [{ legalForm: 'UG' as const, year: 2025 }, { legalForm: 'GMBH' as const, year: 2026 }]) test(`completes the reviewed HGB close, E-Bilanz export, KSt and GewSt lifecycle for a ${scenario.year} ${scenario.legalForm}`, async ({ browser }, testInfo) => {
    const year = scenario.year; const priorYear = year - 1
    const baseURL = testInfo.project.use.baseURL as string
    const ownerContext = await browser.newContext({ baseURL }); await ownerContext.addCookies([{ name: 'NEXT_LOCALE', value: 'en', url: baseURL }]); const ownerPage = await ownerContext.newPage()
    const reviewerContext = await browser.newContext({ baseURL }); const reviewerPage = await reviewerContext.newPage()
    const password = 'Annual-close-password-2026!'
    const ownerEmail = `hgb-owner-${randomUUID()}@example.test`; const reviewerEmail = `hgb-reviewer-${randomUUID()}@example.test`
    await ownerPage.goto('/sign-up'); await new AuthenticationPage(ownerPage).signUp('HGB owner', ownerEmail, password); await expect(ownerPage).toHaveURL('/')
    await reviewerPage.goto('/sign-up'); await new AuthenticationPage(reviewerPage).signUp('HGB reviewer', reviewerEmail, password); await expect(reviewerPage).toHaveURL('/')
    const ownerAccess = new AccessPage(ownerPage); await ownerAccess.open(); const ownerId = await ownerAccess.activeTenantId()
    const reviewerAccess = new AccessPage(reviewerPage); await reviewerAccess.open(); const reviewerId = await reviewerAccess.activeTenantId()
    await ownerAccess.grantAccountant(reviewerEmail)
    await reviewerAccess.open(); await reviewerAccess.selectCompany(ownerId)

    const ownerAnnualClose = new AnnualClosePage(ownerPage)
    const evidenceId = await ownerAnnualClose.uploadEvidence(invoicePdf)
    const compliance = new ComplianceSetupPage(ownerPage); await compliance.open()
    const companyProfile = { companyName: scenario.legalForm === 'UG' ? 'HGB E2E UG (haftungsbeschränkt)' : 'HGB E2E GmbH', registeredAddress: { streetAndHouseNumber: 'Test 1', zipCode: '10115', city: 'Berlin', country: 'DE' }, legalForm: scenario.legalForm, registerCourt: 'Berlin', registerNumber: 'HRB 1', taxNumber: '1234567890123', taxOffice: 'Berlin', vatRegime: 'STANDARD', vatFilingFrequency: 'MONTHLY', activity: 'Software', sizeClass: 'MICRO', chart: 'CUSTOM:HGB-MICRO', elections: [], annualTaxProfile: { tradeBusiness: true, establishments: 1, adviserExtension: false, municipalityCode: '11000000', tradeTaxMultiplierBasisPoints: 41000, foreignIncome: false, groupOrConsolidation: false, lossCarry: false, specialRegime: false, withholdingOrCredits: false, payroll: false }, eBilanz: { accountingStandard: 'HGB', incomeStatementMethod: 'GKV', statementType: 'E', reportStatus: 'E', consolidationRange: 'EA', incomeClassification: 'trade' } }
    await compliance.createPeriod(year); await compliance.createPeriod(priorYear)
    await compliance.saveCapitalCompanyProfile({ legalForm: scenario.legalForm, year, companyName: companyProfile.companyName })
    await compliance.onboardHistoricalHgb([priorYear, year], evidenceId)
    const mappingIds = await compliance.visibleMappingIds(year)
    await compliance.configureReviewPolicy(ownerId, reviewerId)
    await ownerAnnualClose.postRevenueWithEvidence(invoicePdf, year)
    await ownerAnnualClose.prepareSupportedMicroClose({ year, legalForm: scenario.legalForm, evidenceId, mappingIds })
    const requiredKinds = HGB_WORKPAPER_KINDS.filter(kind => !['FIXED_ASSETS_AND_DEPRECIATION', 'INVENTORY_COUNT_AND_VALUATION', 'NOTES'].includes(kind))
    await new AnnualClosePage(reviewerPage).approvePreparedWorkpapers(year, requiredKinds)
    await compliance.open(); const periodId = await compliance.visiblePeriodId(year); const packageId = await compliance.createAnnualAccounts(periodId)
    const reviewerCompliance = new ComplianceSetupPage(reviewerPage); await reviewerCompliance.open(); await reviewerCompliance.approveAnnualAccounts(packageId)
    await ownerAnnualClose.evaluateReadyClose(year, { evidenceId, signedAt: `${year + 1}-01-15T11:00` })
    await ownerAnnualClose.lockReadyFiscalYear(year)

    const eBalance = new EBalancePage(ownerPage)
    await eBalance.open(year)
    await eBalance.expectAuthoritativeMasterData({ companyName: companyProfile.companyName, street: 'Test 1', postalCode: '10115', city: 'Berlin', taxNumber: '1234567890123', legalForm: scenario.legalForm })
    await eBalance.exportCurrentValidationPackage(year)

    const corporationTax = new TaxWorkflowPage(ownerPage, year)
    await corporationTax.prepare('KST')
    const adjustmentPage = await ownerContext.newPage()
    await new TaxWorkflowPage(adjustmentPage, year).saveEvidenceBackedAdjustment('KST', evidenceId)
    await adjustmentPage.close()
    await corporationTax.expectPreparedSourceChangeBlocked(/evidenced tax adjustments changed; prepare and approve a new annual dataset/)

    for (const kind of ['KST', 'GEWST'] as const) {
      await ownerPage.goto(`/tax/${year}`)
      await expect(ownerPage.getByText(/Local lifecycle emulator/)).toBeVisible()
      await ownerPage.getByLabel('Form').selectOption(kind)
      await ownerPage.getByRole('button', { name: 'Validate officially' }).click()
      await expect(ownerPage.getByText('The official gateway validated the dataset.')).toBeVisible()
      await expect(ownerPage.getByText(/Finanzamt assessment is authoritative/).first()).toBeVisible()
      await ownerPage.getByLabel('I explicitly approve this binding transmission.').check()
      await ownerPage.getByRole('button', { name: 'Submit binding' }).click()
      await expect(ownerPage.getByRole('cell', { name: `e2e-${kind.toLowerCase()}-${year}-receipt` })).toBeVisible()
    }
    await ownerPage.goto(`/tax/${year}`)
    await ownerPage.getByLabel('Accepted declaration').selectOption({ label: `KST · ${year}` })
    await ownerPage.getByLabel('Notice ID').fill(`KST-${year}-E2E-1`)
    await ownerPage.getByLabel('Assessed amount (cents)').fill('42')
    await ownerPage.getByLabel('Received on').fill(new Date().toISOString().slice(0, 10))
    await ownerPage.getByLabel('Evidence document ID').fill(evidenceId)
    await ownerPage.getByRole('button', { name: 'Record authoritative assessment' }).click()
    await expect(ownerPage.getByText('Authoritative Finanzamt assessment recorded and reconciled.')).toBeVisible()
    await expect(ownerPage.getByRole('cell', { name: `KST-${year}-E2E-1` })).toBeVisible()
    await ownerPage.reload()
    await expect(ownerPage.getByRole('cell', { name: `KST-${year}-E2E-1` })).toBeVisible()
    if (scenario.legalForm === 'GMBH') {
      await compliance.saveAuthoritativeCityChange({ city: 'Berlin-Mitte', effectiveFrom: `${year}-08-04` })
      await eBalance.open(year)
      await eBalance.expectAuthoritativeSourceStale()
      await ownerAnnualClose.evaluateReadyClose(year, { evidenceId, signedAt: `${year + 1}-01-16T11:00` })
      await compliance.open()
      const reopenRequestId = await compliance.requestPeriodReopen(periodId)
      await reviewerCompliance.open()
      await reviewerCompliance.approvePeriodReopen(reopenRequestId)
      await ownerAnnualClose.lockReadyFiscalYear(year)
      await eBalance.open(year)
      await eBalance.exportRemediatedAuthoritativePackage(year)
    }
    await ownerContext.close(); await reviewerContext.close()
  })
})
