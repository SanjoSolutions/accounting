import { readFileSync } from 'node:fs'
import { test } from '@playwright/test'
import { FixedAssetsPage } from './fixed-assets-page'

const evidence = readFileSync(new URL('./fixtures/invoice.pdf', import.meta.url))
test.describe('real fixed-asset register journey', () => {
  test('Given acquisition and retirement evidence, when depreciation and a full no-proceeds retirement are approved, then exact immutable journals and the closed asset survive reload', async ({ page }) => {
    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`; const assets = new FixedAssetsPage(page)
    await assets.signUp(`Assets ${unique}`, `assets-${unique}@example.test`); await assets.uploadEvidence(evidence); await assets.registerAndPost(); await assets.uploadRetirementEvidence(evidence); await assets.postFullRetirement(); await assets.provePersistenceAndJournal()
  })

  test('Given acquisition and sale evidence, when a partially depreciated asset is sold domestically, then the exact DATEV gain pair, gross receivable, 19% VAT, derecognition, and permanent closure survive reload', async ({ page }) => {
    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`; const assets = new FixedAssetsPage(page)
    await assets.signUp(`Asset sale ${unique}`, `asset-sale-${unique}@example.test`); await assets.createSaleCustomer(); await assets.uploadEvidence(evidence); await assets.registerAndPost(); await assets.uploadSaleEvidence(evidence); await assets.postFullDomesticSale(); await assets.proveSalePersistenceAndJournal()
  })
})
