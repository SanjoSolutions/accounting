import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test, expect } from '@playwright/test'
import { AnnualClosePage } from './annual-close-page'
import { prepareIndependentClose } from './independent-close-fixture'
import { TaxWorkflowPage } from './tax-workflow-page'
import { EBalancePage } from './e-balance-page'
import { AuthenticationPage } from './pages'

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

  for (const scenario of [{ legalForm: 'UG' as const, year: 2025, exportOnly: false }, { legalForm: 'GMBH' as const, year: 2026, exportOnly: false }, { legalForm: 'UG' as const, year: 2026, exportOnly: true }]) test(`completes the reviewed HGB close and ${scenario.exportOnly ? 'authoritative E-Bilanz download' : 'E-Bilanz export, KSt and GewSt lifecycle'} for a ${scenario.year} ${scenario.legalForm}`, async ({ browser }, testInfo) => {
    const { year, ownerContext, reviewerContext, ownerPage, reviewerPage, evidenceId, compliance, reviewerCompliance, periodId, companyProfile, ownerAnnualClose } = await prepareIndependentClose(browser, testInfo, scenario)

    const eBalance = new EBalancePage(ownerPage)
    await eBalance.open(year)
    await eBalance.expectAuthoritativeMasterData({ companyName: companyProfile.companyName, street: 'Test 1', postalCode: '10115', city: 'Berlin', taxNumber: '1234567890123', legalForm: scenario.legalForm })
    await eBalance.approveSyntheticTaxBalance(periodId, year, evidenceId)
    await eBalance.exportCurrentValidationPackage(year)
    if (scenario.exportOnly) { await ownerContext.close(); await reviewerContext.close(); return }

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
      await compliance.open()
      const reopenRequestId = await compliance.requestPeriodReopen(periodId)
      await reviewerCompliance.open()
      await reviewerCompliance.approvePeriodReopen(reopenRequestId)
      await compliance.open()
      const replacementPackageId = await compliance.createAnnualAccounts(periodId)
      await reviewerCompliance.open()
      await reviewerCompliance.approveAnnualAccounts(replacementPackageId)
      await ownerAnnualClose.evaluateReadyClose(year, { evidenceId, signedAt: `${year + 1}-01-16T11:00` })
      await ownerAnnualClose.lockReadyFiscalYear(year)
      await eBalance.open(year)
      await eBalance.approveSyntheticTaxBalance(periodId, year, evidenceId)
      await eBalance.exportRemediatedAuthoritativePackage(year)
    }
    await ownerContext.close(); await reviewerContext.close()
  })
})
