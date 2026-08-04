import { randomUUID } from 'node:crypto'
import { test } from '@playwright/test'
import { CommercialPage } from './commercial-page'

test.describe('real commercial accounting master-data journey', () => {
  test('Given a new small-business user, when a customer is created through the UI, then tenant-scoped master data survives reload', async ({ page }) => {
    const unique = randomUUID().slice(0, 8)
    const commercial = new CommercialPage(page)
    await commercial.signUp(`Commercial ${unique}`, `commercial-${unique}@example.test`, 'playwright-password-2026')
    await commercial.openFromNavigation()
    await commercial.createCustomer(`K-${unique}`, `Kunde ${unique} GmbH`)
    await commercial.expectCustomerSurvivesReload(`K-${unique}`, `Kunde ${unique} GmbH`)
  })
})
