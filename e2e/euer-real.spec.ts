import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { EuerPage } from './euer-page'

test('Given a sole trader, when payments are reviewed, saved and reloaded, then the EÜR retains exact values and exports a manual workpaper', async ({ page, context }, testInfo) => {
  test.setTimeout(180000)
  const baseURL = testInfo.project.use.baseURL as string
  expect(baseURL).toBe('http://127.0.0.1:3227')
  expect(testInfo.config.webServer?.env?.DATABASE_URL).toBe('file:./euer-playwright.db')
  expect(testInfo.config.webServer?.env?.DOCUMENT_STORAGE_ROOT).toBe('./.playwright/euer-documents')
  await context.addCookies([{ name: 'NEXT_LOCALE', value: 'de', url: baseURL }])
  const euer = new EuerPage(page)
  await euer.configure(); await euer.open()
  await euer.add('taxableReceipts', '100,00', 'INCOME-1')
  await euer.add('vatReceived', '19,00', 'VAT-1')
  await euer.add('supplies', '20,00', 'EXPENSE-1')
  await euer.add('inputVatPaid', '3,80', 'INPUT-VAT-1')
  await euer.add('deposits', '500,00', 'OWNER-1')
  await expect(page.getByLabel('Regelmäßig wiederkehrende Zahlung (§ 11 EStG)', { exact: true })).toBeDisabled()
  await expect(page.getByLabel('EÜR-Position', { exact: true }).locator('option[value="smallBusinessReceipts"]')).toHaveCount(0)
  await euer.save(1)
  await expect(page.getByRole('row').filter({ hasText: 'Gewinn/Verlust im geprüften Umfang' })).toContainText('95,20')
  await page.reload()
  await expect(page.getByRole('row').filter({ hasText: 'INCOME-1' }).first()).toBeVisible()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Arbeitsblatt als CSV' }).click()
  const download = await downloadPromise
  const contents = await readFile((await download.path())!, 'utf8')
  expect(contents).toContain('"95,20"'); expect(contents).toContain('Keine elektronische Übermittlung')
  await page.screenshot({ path: testInfo.outputPath('euer-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: testInfo.outputPath('euer-mobile.png'), fullPage: true })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/compliance')
  await expect(page.getByLabel('Gewinnermittlung', { exact: true })).toHaveValue('EUER')
  await page.locator('.compliance-profile-form').screenshot({ path: testInfo.outputPath('euer-profile-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.compliance-profile-form').screenshot({ path: testInfo.outputPath('euer-profile-mobile.png') })
})
