import { randomUUID } from 'node:crypto'
import { test, expect } from '@playwright/test'
import { AccessPage, AuthenticationPage, SettingsPage, SpecialistAuthorizationPage } from './pages'

test.describe('real tenant roles', () => {
  test.setTimeout(60_000)
  test('Given an owner and a read-only adviser, when access is granted and the company is selected, then shared reads work and settings mutation fails visibly', async ({ browser, baseURL }) => {
    const suffix = randomUUID()
    const password = 'E2e-password-123!'
    const ownerEmail = `owner-${suffix}@example.test`
    const readerEmail = `reader-${suffix}@example.test`
    const readerContext = await browser.newContext({ baseURL, storageState: undefined })
    const ownerContext = await browser.newContext({ baseURL, storageState: undefined })
    const readerPage = await readerContext.newPage()
    const ownerPage = await ownerContext.newPage()
    try {
      const readerAuth = new AuthenticationPage(readerPage)
      await readerAuth.open('/sign-up')
      await readerAuth.signUp('Read only adviser', readerEmail, password)
      await expect(readerPage).toHaveURL('/')

      const ownerAuth = new AuthenticationPage(ownerPage)
      await ownerAuth.open('/sign-up')
      await ownerAuth.signUp('Company owner', ownerEmail, password)
      await expect(ownerPage).toHaveURL('/')

      const ownerAccess = new AccessPage(ownerPage)
      await ownerAccess.grant(readerEmail, 'READ_ONLY', 'Annual accounts inspection mandate')
      const accessOverview = await (await ownerPage.request.get('/api/access')).json()
      const ownerId = accessOverview.data.activeTenantId as string

      const readerAccess = new AccessPage(readerPage)
      await readerAccess.useCompany(ownerId)
      await expect(readerPage.getByText('Your role: READ_ONLY', { exact: false })).toBeVisible()

      const settings = new SettingsPage(readerPage)
      await settings.open('/settings')
      const saveResponse = readerPage.waitForResponse(response => new URL(response.url()).pathname === '/api/settings' && response.request().method() === 'PUT')
      await settings.updateIssuer('Forbidden mutation GmbH')
      expect((await saveResponse).status()).toBe(403)
      await expect(readerPage.getByRole('alert').filter({ hasText: 'role does not permit' })).toBeVisible()

      const readResponse = await readerPage.request.get('/api/settings')
      expect(readResponse.status()).toBe(200)
      const settingsBody = await readResponse.json()
      expect(settingsBody.data.id).toBe(`company:${ownerId}`)
      expect(settingsBody.data.invoiceIssuer.name).not.toBe('Forbidden mutation GmbH')

      const specialist = new SpecialistAuthorizationPage(readerPage)
      await specialist.attemptCompliancePeriodMutation()
      await specialist.expectTaxMutationDeniedBeforeGateway()
    } finally {
      await readerContext.close(); await ownerContext.close()
    }
  })
})
