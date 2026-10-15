import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { PrismaClient } from '../src/generated/prisma/client'
import { expect, test } from '@playwright/test'
import { TaxReviewPage } from './tax-review-page'

test('Given an isolated company without a gateway, when VAT is prepared and downloaded for review, then no transmission is authorized', async ({ page, context, baseURL }, testInfo) => {
  expect(baseURL).toBe('http://127.0.0.1:3229')
  await context.addCookies([{ name: 'NEXT_LOCALE', value: 'en', domain: '127.0.0.1', path: '/' }])
  const signUp = await page.request.post('/api/auth/sign-up/email', {
    headers: { Origin: baseURL! },
    data: { name: 'Synthetic Review Company', email: `review-${randomUUID()}@example.test`, password: 'Synthetic-review-test-only-2026!' },
  })
  expect(signUp.ok(), await signUp.text()).toBe(true)
  const overview = await page.request.get('/api/compliance')
  expect(overview.ok()).toBe(true)
  const ownerId = (await overview.json()).data.tenantId as string
  const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: 'file:./elster-review-playwright.db' }) })
  try {
    await prisma.companyProfileVersion.create({ data: {
      id: randomUUID(), ownerId, effectiveFrom: new Date('2026-01-01T00:00:00.000Z'), createdBy: ownerId, reason: 'Synthetic review test',
      payload: JSON.stringify({ companyName: 'Synthetic Review Company', legalForm: 'SOLE_TRADER', taxNumber: '12/345/67890', taxOffice: 'Berlin', registeredAddress: { streetAndHouseNumber: 'Example Street 1', zipCode: '10115', city: 'Berlin', country: 'DE' }, vatRegime: 'STANDARD', vatFilingFrequency: 'MONTHLY', activity: 'Software', sizeClass: 'MICRO', chart: 'SKR03', elections: [] }),
    } })
    // Loading the ledger initializes the synthetic fiscal year and account mapping.
    const review = new TaxReviewPage(page)
    await review.initializeLedger()
    const workflowRequests: string[] = []
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/tax/workflows')) workflowRequests.push(request.url()) })
    await review.open()
    for (const kind of ['USTVA', 'UST_ANNUAL'] as const) {
      await review.prepare(kind)
      const download = await review.download()
      expect(download.suggestedFilename()).toBe(`tax-review-${kind}-${kind === 'USTVA' ? '2026-01' : '2026'}.json`)
      const contents = JSON.parse(await readFile((await download.path())!, 'utf8'))
      expect(contents).toMatchObject({ purpose: 'LOCAL_REVIEW_ONLY', portalDraftCreated: false, transmissionPerformed: false, dataset: { kind, taxpayerId: ownerId, fields: { ZAHLLAST: 0 } } })
      expect(contents.dataset.formVersion).toBe(`${kind}-2026.1`)
      expect(workflowRequests).toEqual([])
    }
    await page.getByText('Prepared values', { exact: true }).click()
    await page.screenshot({ path: testInfo.outputPath('review-desktop.png'), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: testInfo.outputPath('review-mobile.png'), fullPage: true })
    await review.expectUnavailableValidationKeepsSubmissionDisabled()
    await page.getByLabel('Form', { exact: true }).selectOption('USTVA')
    await expect(page.getByRole('heading', { name: 'Review before ELSTER', exact: true })).toHaveCount(0)
    await review.expectSubmissionDisabled()
    expect(await prisma.taxWorkflowRecord.count({ where: { ownerId } })).toBe(0)
    expect(await prisma.taxSubmissionRequest.count({ where: { ownerId } })).toBe(0)
    expect(await prisma.taxDatasetPreparationRecord.count({ where: { ownerId } })).toBe(2)
  } finally { await prisma.$disconnect() }
})
