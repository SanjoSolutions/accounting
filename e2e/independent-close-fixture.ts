import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, type Browser, type TestInfo } from '@playwright/test'
import { AnnualClosePage } from './annual-close-page'
import { HGB_WORKPAPER_KINDS } from '../src/core/hgbClose'
import { AuthenticationPage } from './pages'
import { AccessPage, ComplianceSetupPage } from './compliance-setup-page'
const invoicePdf = readFileSync(new URL('./fixtures/invoice.pdf', import.meta.url))

export async function prepareIndependentClose(browser: Browser, testInfo: TestInfo, scenario: { year: number; legalForm: 'UG' | 'GMBH' }) {
    const year = scenario.year; const priorYear = year - 1
    const baseURL = testInfo.project.use.baseURL as string
    const ownerContext = await browser.newContext({ baseURL }); await ownerContext.addCookies([{ name: 'NEXT_LOCALE', value: 'en', url: baseURL }]); const ownerPage = await ownerContext.newPage()
    ownerContext.setDefaultTimeout(15_000); const reviewerContext = await browser.newContext({ baseURL }); reviewerContext.setDefaultTimeout(15_000); await reviewerContext.addCookies([{ name: 'NEXT_LOCALE', value: 'en', url: baseURL }]); const reviewerPage = await reviewerContext.newPage()
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

    return { year, ownerContext, reviewerContext, ownerPage, reviewerPage, evidenceId, compliance, reviewerCompliance, periodId, companyProfile, ownerAnnualClose }
}
