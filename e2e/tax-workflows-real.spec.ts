import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { test, expect, type Browser } from '@playwright/test'
import { PrismaClient } from '../src/generated/prisma/client'
import { TaxWorkflowPage } from './tax-workflow-page'

const invoicePdf = readFileSync(new URL('./fixtures/invoice.pdf', import.meta.url))
const password = 'Tax-workflow-password-2026!'

async function preparedTenant(browser: Browser, baseURL: string, purpose: string) {
  const context = await browser.newContext({ baseURL })
  await context.addCookies([{ name: 'NEXT_LOCALE', value: 'en', url: baseURL }])
  const page = await context.newPage()
  const email = `${purpose}-${randomUUID()}@example.test`
  const signUp = await page.request.post('/api/auth/sign-up/email', {
    headers: { Origin: baseURL },
    data: { name: 'Tax Workflow E2E', email, password },
  })
  expect(signUp.ok(), `${signUp.status()} ${await signUp.text()}`).toBe(true)
  const overviewResponse = await page.request.get('/api/compliance')
  expect(overviewResponse.ok()).toBe(true)
  const ownerId = (await overviewResponse.json()).data.tenantId as string

  const adapter = new PrismaBetterSqlite3({ url: 'file:./playwright.db' })
  const prisma = new PrismaClient({ adapter })
  await prisma.companyProfileVersion.create({
    data: {
      id: randomUUID(),
      ownerId,
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      payload: JSON.stringify({
        companyName: 'E2E Example',
        legalForm: 'SOLE_TRADER',
        taxNumber: '12/345/67890',
        taxOffice: 'Berlin',
        registeredAddress: {
          streetAndHouseNumber: 'Example Street 1',
          zipCode: '10115',
          city: 'Berlin',
          country: 'DE',
        },
        vatRegime: 'STANDARD',
        vatFilingFrequency: 'MONTHLY',
        activity: 'Software',
        sizeClass: 'MICRO',
        chart: 'SKR03',
        elections: [],
      }),
      createdBy: ownerId,
      reason: 'Anonymized 2026 E2E prerequisite',
    },
  })
  await prisma.$disconnect()

  const tax = new TaxWorkflowPage(page)
  await tax.postStandardRatedSale(invoicePdf)
  return { context, page, tax }
}

test.describe('real 2026 VAT filing workflows', () => {
  test('prepares, validates and submits the January UStVA with a durable receipt', async ({ browser }, testInfo) => {
    const tenant = await preparedTenant(browser, testInfo.project.use.baseURL as string, 'ustva')
    try {
      await tenant.tax.submit('USTVA', 'e2e-ustva-2026-01-receipt')
    } finally {
      await tenant.context.close()
    }
  })

  test('prepares, validates and submits the annual VAT return with a durable receipt', async ({ browser }, testInfo) => {
    const tenant = await preparedTenant(browser, testInfo.project.use.baseURL as string, 'ust-annual')
    try {
      await tenant.tax.submit('UST_ANNUAL', 'e2e-ust_annual-2026-receipt')
    } finally {
      await tenant.context.close()
    }
  })
})
