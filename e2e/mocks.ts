import type { Page, Route } from '@playwright/test'

export const currentYear = new Date().getFullYear()

export const openWorkspace = {
  fiscalYear: { id: `fy-${currentYear}`, year: currentYear, status: 'OPEN', lockedAt: null },
  accounts: [
    { id: 'office', number: 4930, name: 'Office supplies', category: 'EXPENSE' },
    { id: 'bank', number: 1200, name: 'Bank', category: 'ASSET' },
    { id: 'revenue', number: 8400, name: 'Revenue', category: 'REVENUE' },
  ],
  entries: [{
    id: 'entry-1',
    sequenceNumber: 1,
    bookingDate: `${currentYear}-02-03`,
    description: 'Opening transaction',
    documents: [{ id: 'document-1', fileName: 'invoice.pdf', url: '/api/documents/document-1/file' }],
    lines: [
      { id: 'line-1', debitCents: 11900, creditCents: 0, account: { id: 'office', number: 4930, name: 'Office supplies', category: 'EXPENSE' } },
      { id: 'line-2', debitCents: 0, creditCents: 11900, account: { id: 'bank', number: 1200, name: 'Bank', category: 'ASSET' } },
    ],
  }],
  closingIssues: [],
  statements: {
    assetsCents: 11900,
    liabilitiesCents: 0,
    equityCents: 11900,
    revenueCents: 0,
    expenseCents: 11900,
    netIncomeCents: -11900,
    balanceDifferenceCents: 0,
    balances: [{ accountId: 'bank', balanceCents: 11900, eBilanzPosition: 'bs.ass.currAss.cashEquiv.cash' }],
  },
}

export const settings = {
  invoiceIssuer: {
    name: 'Example GmbH',
    streetAndHouseNumber: 'Example Street 1',
    zipCode: '10115',
    city: 'Berlin',
    country: 'DE',
  },
  chartOfAccounts: 'SKR03',
  companyProfile: {
    companyName: 'Example GmbH',
    legalForm: 'GMBH',
    taxNumber: '1234567890123',
    taxOffice: 'Berlin',
    vatRegime: 'STANDARD',
    vatFilingFrequency: 'MONTHLY',
    activity: 'Consulting',
    sizeClass: 'MICRO',
    chart: 'SKR03',
    elections: [],
    eBilanz: {
      accountingStandard: 'HGB',
      incomeStatementMethod: 'GKV',
      statementType: 'E',
      reportStatus: 'E',
      consolidationRange: 'EA',
      incomeClassification: 'trade',
    },
  },
}

export const complianceOverview = {
  tenantId: 'tenant-e2e',
  profile: { value: settings.companyProfile, applicability: { KST: { applicable: true, basis: 'GMBH', overridden: false } } },
  periods: [{ id: `fy-${currentYear}`, referenceYear: currentYear, label: String(currentYear), startsAt: `${currentYear}-01-01`, endsAt: `${currentYear}-12-31`, status: 'OPEN' }],
  chart: { chart: 'SKR03', mappings: [] },
  audit: { verified: true, events: [] },
  operations: { policy: null, profileAddressMigrations: [], artifacts: [], drafts: [], reopenRequests: [], amendments: [], backups: [] },
}

export async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

export async function mockAccounting(page: Page) {
  await page.route('**/api/booking-records?year=*', route => fulfillJson(route, openWorkspace))
}

export async function mockSettings(page: Page) {
  await page.route('**/api/settings', route => {
    if (route.request().method() === 'GET') return fulfillJson(route, { data: settings })
    return fulfillJson(route, { data: settings })
  })
}

export async function mockCompliance(page: Page) {
  await mockSettings(page)
  await page.route('**/api/compliance', route => {
    if (route.request().method() === 'GET') return fulfillJson(route, { data: complianceOverview })
    return fulfillJson(route, { data: { ok: true } })
  })
}
