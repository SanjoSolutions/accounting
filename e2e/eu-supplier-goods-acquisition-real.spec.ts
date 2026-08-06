import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from '@playwright/test'
import { DocumentExtractionPage } from './document-extraction-page'
import { SettingsPage } from './pages'

test.describe('real intra-EU supplier goods acquisition journey', () => {
  test('Given a Dutch category-K invoice with German delivery evidence and explicit controls, when ordinary 19% goods are confirmed, then net payable and KZ 89/61 canonical VAT evidence survive reload', async ({ page }) => {
    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const invoice = new DocumentExtractionPage(page)
    await invoice.signUp(`EU goods ${unique}`, `eu-goods-${unique}@example.test`, 'playwright-password-2026')
    await new SettingsPage(page).configureEuAcquisition('SKR03', '1574', '1774', 'DE987654321')
    await invoice.uploadReviewAndPostEuGoodsAcquisitionUbl(await readFile(path.join(process.cwd(), 'src/core/data_fixtures/eInvoice/eu-goods-ubl.xml')))
    await invoice.proveEuGoodsAcquisitionAfterReload()
  })
})
