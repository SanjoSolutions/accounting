import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test, expect } from '@playwright/test'
import { AnnualClosePage } from './annual-close-page'
import { AnnualDocumentPage } from './annual-document-page'
import { AuthenticationPage } from './pages'
import { AccessPage, ComplianceSetupPage } from './compliance-setup-page'

test('Given a reviewed 2026 UG close, when exact-version documents are exported, then printable accounts and a minimized manual package are retained', async ({ browser }, testInfo) => {
  test.setTimeout(600_000)
  const baseURL = testInfo.project.use.baseURL as string
  // Browser safety invariant: this config's server has an explicit disposable database and isolated storage.
  expect(baseURL).toBe('http://127.0.0.1:3113')
  const server = testInfo.config.webServer!
  expect(server.env?.DATABASE_URL).toBe('file:./annual-documents-playwright.db')
  expect(server.env?.DOCUMENT_STORAGE_ROOT).toBe('./.playwright/annual-documents')
  const ownerContext = await browser.newContext({ baseURL }); await ownerContext.addCookies([{ name: 'NEXT_LOCALE', value: 'en', url: baseURL }])
  const reviewerContext = await browser.newContext({ baseURL }); await reviewerContext.addCookies([{ name: 'NEXT_LOCALE', value: 'en', url: baseURL }])
  const owner = await ownerContext.newPage(); const reviewer = await reviewerContext.newPage()
  const password = 'Annual-document-test-password-2026!'
  const reviewerEmail = `document-review-${randomUUID()}@example.test`
  await owner.goto('/sign-up'); await new AuthenticationPage(owner).signUp('Document owner', `document-owner-${randomUUID()}@example.test`, password); await expect(owner).toHaveURL('/')
  await reviewer.goto('/sign-up'); await new AuthenticationPage(reviewer).signUp('Document reviewer', reviewerEmail, password); await expect(reviewer).toHaveURL('/')
  const ownerAccess = new AccessPage(owner); await ownerAccess.open(); const ownerId = await ownerAccess.activeTenantId()
  const reviewerAccess = new AccessPage(reviewer); await reviewerAccess.open(); const reviewerId = await reviewerAccess.activeTenantId()
  await ownerAccess.grantAccountant(reviewerEmail); await reviewerAccess.open(); await reviewerAccess.selectCompany(ownerId)
  const close = new AnnualClosePage(owner)
  const pdf = readFileSync(new URL('./fixtures/invoice.pdf', import.meta.url))
  const evidenceId = await close.uploadEvidence(pdf)
  const setup = new ComplianceSetupPage(owner); await setup.open()
  const overview = await (await owner.request.get('/api/compliance')).json()
  for (const year of [2025, 2026]) if (!overview.data.periods.some((period: { referenceYear: number }) => period.referenceYear === year)) {
    const created = await owner.request.post('/api/compliance', { data: { action: 'period.create', referenceYear: year, label: `HGB ${year}`, startsAt: `${year}-01-01`, endsAt: `${year}-12-31`, reason: 'Synthetic export fixture period' } })
    expect(created.ok(), await created.text()).toBeTruthy()
  }
  await setup.saveCapitalCompanyProfile({ legalForm: 'UG', year: 2026, companyName: 'Dokumentenprüfung UG (haftungsbeschränkt)' })
  await setup.onboardHistoricalHgb([2025, 2026], evidenceId)
  const configured = (await (await owner.request.get('/api/compliance')).json()).data
  const mappingIds = configured.chart.mappings.filter((mapping: { effectiveFrom: string }) => mapping.effectiveFrom.startsWith('2026')).map((mapping: { id: string }) => mapping.id)
  expect(mappingIds).toHaveLength(2)
  await setup.configureReviewPolicy(ownerId, reviewerId)
  await close.postRevenueWithEvidence(pdf, 2026)
  const documents = new AnnualDocumentPage(owner); await documents.prepareDocumentClose(2026, evidenceId, mappingIds, reviewer)
  await setup.open()
  const periods = (await (await owner.request.get('/api/compliance')).json()).data.periods
  const periodId = periods.find((period: { referenceYear: number }) => period.referenceYear === 2026).id
  const packageId = await setup.createAnnualAccounts(periodId)
  const reviewerSetup = new ComplianceSetupPage(reviewer); await reviewerSetup.open(); await reviewerSetup.approveAnnualAccounts(packageId)
  await documents.evaluateClose(2026, packageId, evidenceId)
  await documents.exportAndInspect(packageId, testInfo)
  await ownerContext.close(); await reviewerContext.close()
})
