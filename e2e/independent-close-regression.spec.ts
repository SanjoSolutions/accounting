import { expect, test } from '@playwright/test'
import { prepareIndependentClose } from './independent-close-fixture'

for (const scenario of [{ year: 2025, legalForm: 'UG' as const }, { year: 2026, legalForm: 'GMBH' as const }]) {
  test(`Given the default policy, distinct people can still prepare, review and lock the ${scenario.year} ${scenario.legalForm} close`, async ({ browser }, testInfo) => {
    test.setTimeout(600_000)
    // Check isolation before opening any browser context in the shared page fixture.
    expect(testInfo.project.use.baseURL).toBe('http://127.0.0.1:3110')
    const server = testInfo.config.webServer as { env?: Record<string, string> }
    expect(server.env?.DATABASE_URL).toBe('file:./ug-close-playwright.db')
    expect(server.env?.DOCUMENT_STORAGE_ROOT).toBe('./.playwright/ug-close-documents')
    const close = await prepareIndependentClose(browser, testInfo, scenario)
    const papers = (await (await close.ownerPage.request.get(`/api/fiscal-years/${scenario.year}/hgb-close/workpapers`)).json()).data
    expect(papers.reviewPolicy).toBeNull()
    for (const paper of papers.workpapers) {
      expect(paper.reviewMode).toBe('INDEPENDENT')
      expect(paper.reviewedBy).not.toBe(paper.preparedBy)
    }
    const ledger = await (await close.ownerPage.request.get(`/api/booking-records?year=${scenario.year}`)).json()
    expect(ledger.fiscalYear).toMatchObject({ status: 'CLOSED', lockedAt: expect.any(String) })
    await close.ownerContext.close(); await close.reviewerContext.close()
  })
}
