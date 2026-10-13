import { randomUUID } from 'node:crypto'
import { test, expect } from '@playwright/test'
import { AuthenticationPage } from './pages'
import { AccessPage, ComplianceSetupPage } from './compliance-setup-page'
import { AnnualClosePage } from './annual-close-page'
import { HGB_WORKPAPER_KINDS } from '../src/core/hgbClose'
import { seedSyntheticUgOpening, syntheticUgEvidence } from './ug-close-fixture'

test.use({ actionTimeout: 15_000 })

test('Given documented synthetic opening balances, a sole owner completes the real 2026 UG close through self-review, reserve posting, annual approval, signatures and lock', async ({ browser }, testInfo) => {
  test.setTimeout(600_000)
  const baseURL = testInfo.project.use.baseURL as string
  expect(baseURL).toBe('http://127.0.0.1:3110')
  const server = testInfo.config.webServer as { env?: Record<string, string> } | null
  expect(server?.env?.DATABASE_URL).toBe('file:./ug-close-playwright.db')
  expect(server?.env?.DOCUMENT_STORAGE_ROOT).toBe('./.playwright/ug-close-documents')
  const context = await browser.newContext({ baseURL })
  context.setDefaultTimeout(15_000)
  await context.addCookies([{ name: 'NEXT_LOCALE', value: 'en', url: baseURL }])
  const page = await context.newPage()
  await page.goto('/sign-up')
  await new AuthenticationPage(page).signUp('Synthetic UG sole owner', `ug2026-${randomUUID()}@example.test`, 'Synthetic-close-password-2026!')
  await expect(page).toHaveURL('/')
  const access = new AccessPage(page); await access.open(); const ownerId = await access.activeTenantId()
  const uploaded = await page.request.post('/api/documents', { headers: { 'content-type': 'application/xml', 'x-document-file-name': 'synthetic-ug-close-evidence.xml' }, data: `<syntheticCloseEvidence>${syntheticUgEvidence.replaceAll('&', '&amp;')}</syntheticCloseEvidence>` })
  expect(uploaded.ok(), await uploaded.text()).toBe(true)
  const evidenceId = (await uploaded.json()).data.id as string
  // Explicit DB/storage/URL guards above precede all browser or synthetic setup actions.
  const compliance = new ComplianceSetupPage(page)
  await compliance.open(); await compliance.createPeriod(2026); await compliance.createPeriod(2025)
  await page.request.get('/api/booking-records?year=2026')
  const ug = await seedSyntheticUgOpening(ownerId, evidenceId, baseURL)
  await compliance.saveCapitalCompanyProfile({ legalForm: 'UG', year: 2026, companyName: 'Synthetic Single Owner UG (haftungsbeschränkt)' })
  await compliance.onboardHistoricalHgb([2025, 2026], evidenceId, true)
  const mappingIds = await compliance.visibleMappingIds(2026)
  const close = new AnnualClosePage(page)
  await close.prepareSupportedMicroClose({ year: 2026, legalForm: 'UG', evidenceId, mappingIds, ug })
  await close.selectOwnerReviewPolicy(evidenceId)
  const policyPanel = page.getByTestId('hgb-review-policy')
  if (await policyPanel.getAttribute('open') === null) await policyPanel.locator('summary').click()
  await page.screenshot({ path: testInfo.outputPath('owner-policy-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: testInfo.outputPath('owner-policy-mobile.png'), fullPage: true })
  await page.setViewportSize({ width: 1280, height: 720 })
  const kinds = HGB_WORKPAPER_KINDS.filter(kind => !['FIXED_ASSETS_AND_DEPRECIATION', 'INVENTORY_COUNT_AND_VALUATION', 'NOTES'].includes(kind))
  await close.approvePreparedWorkpapers(2026, kinds, true)
  await close.postUgReserve()
  const papers = (await (await page.request.get('/api/fiscal-years/2026/hgb-close/workpapers')).json()).data
  expect(papers.workpapers).toHaveLength(12)
  for (const paper of papers.workpapers) expect(paper).toMatchObject({ status: 'REVIEWED', preparedBy: ownerId, reviewedBy: ownerId, reviewMode: 'OWNER_SELF_REVIEW', reviewPolicyId: papers.reviewPolicy.id, reviewedAt: expect.any(String), reviewReason: expect.stringContaining('sole owner') })
  await page.screenshot({ path: testInfo.outputPath('equity-review-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: testInfo.outputPath('equity-review-mobile.png'), fullPage: true })
  await page.setViewportSize({ width: 1280, height: 720 })
  await compliance.open(); const periodId = await compliance.visiblePeriodId(2026)
  const packageId = await compliance.createAnnualAccounts(periodId)
  await compliance.approveAnnualAccounts(packageId)
  const reporting = (await (await page.request.get('/api/compliance?view=reporting')).json()).data
  const annualPackage = reporting.packages.find((item: { id: string }) => item.id === packageId)
  expect(annualPackage).toMatchObject({ status: 'APPROVED', createdBy: ownerId, approvedBy: ownerId })
  const envelope = JSON.parse(annualPackage.payload); const annual = JSON.parse(envelope.immutablePayload)
  expect(envelope.hgbCloseSource.reviewPolicy.mode).toBe('OWNER_SELF_REVIEW')
  expect(annual.ugResultAppropriation).toMatchObject({ annualResultCents: 11900, priorLossCarryforwardCents: 10000, reserveAllocationCents: 475, carryforwardCents: 1425 })
  expect(annual.balanceSheet.find((line: { code: string }) => line.code === 'A.ASSETS')).toMatchObject({ amountCents: 101900, comparativeCents: 90000 })
  const signature = await page.request.post('/api/documents', { headers: { 'content-type': 'application/xml', 'x-document-file-name': 'synthetic-signatures-resolution.xml' }, data: '<syntheticSignaturesAndResolution>Test-only sole owner signature and adoption resolution.</syntheticSignaturesAndResolution>' })
  expect(signature.ok(), await signature.text()).toBe(true)
  const signatureId = (await signature.json()).data.id as string
  await close.evaluateReadyClose(2026, { evidenceId: signatureId, signedAt: '2027-02-01T12:00', representativeId: ownerId })
  await close.lockReadyFiscalYear(2026)
  const ledger = await (await page.request.get('/api/booking-records?year=2026')).json()
  expect(ledger.fiscalYear).toMatchObject({ status: 'CLOSED', lockedAt: expect.any(String) })
  expect(ledger.statements).toMatchObject({ assetsCents: 101900, netIncomeCents: 11900, balanceDifferenceCents: 0 })
  await context.close()
})
