import { test, expect } from './fixtures'
import {
  complianceOverview,
  currentYear,
  fulfillJson,
  mockCompliance,
  mockSettings,
  openWorkspace,
} from './mocks'

test.describe('data exchange and settings', () => {
  test('importing a DATEV export', async ({ app, page }) => {
    await page.route('**/api/accounting-import', route => fulfillJson(route, {
      imported: 2,
      skipped: 1,
      accounts: 3,
      documents: 0,
      years: [currentYear],
    }))
    await app.open('/export-import')
    await page.getByLabel('Select DATEV CSV files').setInputFiles({
      name: 'EXTF_Buchungsstapel.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('EXTF;700;21'),
    })
    await expect(page.getByText('1 files selected')).toBeVisible()
    await page.getByRole('button', { name: 'Import accounting data' }).click()
    await expect(page.getByRole('status')).toContainText('Processed 2 bookings')
  })

  test('saving invoice issuer and chart settings', async ({ settings, page }) => {
    let saved: Record<string, unknown> | undefined
    await page.route('**/api/settings', async route => {
      if (route.request().method() === 'GET') {
        return fulfillJson(route, {
          data: {
            invoiceIssuer: {
              name: 'Example GmbH',
              streetAndHouseNumber: 'Example Street 1',
              zipCode: '10115',
              city: 'Berlin',
              country: 'DE',
            },
            chartOfAccounts: 'SKR03',
          },
        })
      }
      saved = route.request().postDataJSON()
      await fulfillJson(route, { data: saved })
    })
    await settings.open('/settings')
    await settings.updateIssuer('Updated GmbH')

    await expect.poll(() => saved).toMatchObject({
      invoiceIssuer: { name: 'Updated GmbH' },
      chartOfAccounts: 'SKR04',
    })
  })

  test('preparing an opening balance sheet', async ({ app, page }) => {
    await app.open('/balance-sheets/create')
    await app.expectHeading('Create balance sheet')
    await page.getByLabel('For year').fill(String(currentYear - 1))
    await expect(page.locator('form').getByRole('combobox')).toHaveValue('openingBalanceSheet')
    await expect(page.getByRole('button', { name: 'Create balance sheet' })).toBeEnabled()
  })
})

test.describe('tax and statutory reporting', () => {
  test('validating and submitting a VAT declaration', async ({ tax, page }) => {
    const history = [{
      submissionId: 'submission-1',
      kind: 'USTVA',
      period: `${currentYear}-01`,
      state: 'accepted',
      receipt: 'receipt-1',
      updatedAt: new Date().toISOString(),
    }]
    let submitted = false
    await page.route('**/api/tax/annual?year=*', route => fulfillJson(route, {
      data: { kinds: ['KST'], deadline: `${currentYear + 1}-07-31`, professionalValidationRequired: true },
    }))
    await page.route('**/api/tax/vat-reconciliation?period=*', route => fulfillJson(route, {
      data: { dataset: { kind: 'USTVA', period: `${currentYear}-01`, fields: { KZ81: 10000, ZAHLLAST: 1900 }, drilldown: {} } },
    }))
    await page.route('**/api/tax/workflows', route => {
      if (route.request().method() === 'GET') return fulfillJson(route, { data: submitted ? history : [] })
      const body = route.request().postDataJSON()
      if (body.action === 'submit') submitted = true
      return fulfillJson(route, { data: { state: body.action === 'submit' ? 'accepted' : 'validated' } })
    })

    await tax.open(`/tax/${currentYear}`)
    await tax.validateAndSubmit()
    await expect(page.getByRole('status')).toContainText('transmitted and archived')
    await expect(page.getByRole('cell', { name: 'receipt-1' })).toBeVisible()
  })

  test('preparing, downloading, validating, and submitting an E-Balance report', async ({ app, page }) => {
    await page.route('**/api/booking-records?year=*', route => fulfillJson(route, {
      ...openWorkspace,
      fiscalYear: { ...openWorkspace.fiscalYear, status: 'CLOSED' },
    }))
    await page.route('**/api/compliance/e-bilanz?fiscalYearId=*', route => fulfillJson(route, {
      data: {
        taxonomies: [{ version: '6.9', validForFiscalPeriodsStartingFrom: `${currentYear}-01-01`, validForFiscalPeriodsStartingThrough: `${currentYear}-12-31` }],
        reports: [{ id: 'report-1', fiscalYearId: `fy-${currentYear}`, version: 1, status: 'PREPARED', taxonomyVersion: '6.9', reportChecksum: 'checksum-e2e', createdAt: new Date().toISOString() }],
        reconciliations: [],
      },
    }))
    await page.route('**/api/fiscal-years/*/e-balance/eric-status?*', route => fulfillJson(route, {
      readiness: { validationReady: true, submissionReady: true, testMode: true, issues: [] },
      fiscalYearStatus: 'CLOSED',
      history: [],
    }))
    await page.route('**/api/fiscal-years/*/e-balance/validate', route => fulfillJson(route, { data: { status: 'VALID' } }))
    await page.route('**/api/fiscal-years/*/e-balance/submit', route => fulfillJson(route, { data: { status: 'ACCEPTED' } }))
    await page.route('**/api/fiscal-years/*/e-balance', route => route.fulfill({
      status: 200,
      contentType: 'application/zip',
      body: 'e-balance-package',
    }))

    await app.open(`/e-bilanz/${currentYear}`)
    await page.getByLabel('Company name').fill('Example GmbH')
    await page.getByLabel('Street and house number').fill('Example Street 1')
    await page.getByLabel('Postal code').fill('10115')
    await page.getByLabel('City').fill('Berlin')
    await page.getByLabel('13-digit ELSTER tax number').fill('1234567890123')
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Create XBRL validation package' }).click()
    await expect((await download).suggestedFilename()).toBe(`e-bilanz-${currentYear}-pruefpaket.zip`)
    await page.getByRole('button', { name: 'Validate officially with ERiC' }).click()
    await expect(page.getByRole('status')).toContainText('validated the dataset')
    await page.getByLabel('Certificate PIN (never stored)').fill('123456')
    await page.getByLabel('I confirm the binding submission of this closed fiscal year.').check()
    await page.getByRole('button', { name: 'Submit encrypted to ELSTER' }).click()
    await expect(page.getByRole('status')).toContainText('accepted the encrypted submission')
    await expect(page.getByText('checksum-e2e')).toBeVisible()
  })
})

test.describe('compliance control center', () => {
  test.beforeEach(async ({ page }) => {
    await mockCompliance(page)
  })

  test('saving the authoritative company profile', async ({ compliance, page }) => {
    await compliance.open('/compliance')
    await compliance.saveProfile('Annual profile review')
    await expect(page.getByRole('status')).toContainText('authoritative profile was saved')
  })

  test('creating a fiscal period', async ({ app, page }) => {
    await app.open('/compliance')
    const section = page.getByRole('heading', { name: 'Fiscal periods' }).locator('xpath=ancestor::section[1]')
    await section.getByLabel('Label').fill('Short year')
    await section.getByLabel('Reason').fill('Company formation')
    await section.getByRole('button', { name: 'Create stable period' }).click()
    await expect(page.getByRole('status')).toContainText('fiscal period was created')
  })

  test('activating a custom chart and executing a controlled workflow', async ({ app, page }) => {
    await app.open('/compliance')
    const chart = page.getByRole('heading', { name: 'Chart and mapping lifecycle' }).locator('xpath=ancestor::section[1]')
    await chart.getByLabel('Custom chart ID').fill('CUSTOM:E2E')
    await chart.getByLabel('Change reason').fill('Approved chart migration')
    await chart.getByRole('button', { name: 'Import and activate atomically' }).click()
    await expect(page.getByRole('status')).toContainText('custom chart was imported')

    const workflows = page.getByRole('heading', { name: 'Controlled workflows and operator controls' }).locator('xpath=ancestor::section[1]')
    await workflows.getByRole('button', { name: 'Execute controlled operation' }).click()
    await expect(page.getByRole('status')).toContainText('operation completed')
  })
})

test.describe('navigation and language', () => {
  test('navigating to every primary workspace', async ({ app, page }) => {
    await page.route('**/api/booking-records?year=*', route => fulfillJson(route, openWorkspace))
    await mockSettings(page)
    await page.route('**/api/compliance', route => fulfillJson(route, { data: complianceOverview }))
    await page.route('**/api/tax/workflows', route => fulfillJson(route, { data: [] }))
    await page.route('**/api/tax/annual?year=*', route => fulfillJson(route, { data: { kinds: [], deadline: `${currentYear + 1}-07-31`, professionalValidationRequired: true } }))

    await app.open('/')
    for (const [name, path] of [
      ['Book', '/bookings'],
      ['Journal', '/journal'],
      ['Annual close', '/annual-close/'],
      ['E-balance', '/e-bilanz/'],
      ['Tax filings', '/tax/'],
      ['Export / Import', '/export-import'],
      ['Compliance', '/compliance'],
      ['Settings', '/settings'],
    ] as const) {
      await app.followNavigation(name)
      await expect(page).toHaveURL(new RegExp(path.replaceAll('/', '\\/')))
    }
  })

  test('switching the interface language', async ({ app, page }) => {
    await page.route('**/api/booking-records?year=*', route => fulfillJson(route, openWorkspace))
    await app.open('/')
    await page.getByLabel('Select language').selectOption('de')
    await expect(page.getByRole('link', { name: 'Buchen' })).toBeVisible()
  })
})
