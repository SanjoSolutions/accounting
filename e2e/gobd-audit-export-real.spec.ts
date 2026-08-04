import { test } from '@playwright/test'
import { GobdExportPage } from './gobd-export-page'

test.describe('real GoBD audit export', () => {
  test.setTimeout(120_000)
  test('Given an authoritative fiscal period and chart, when an audit export is created, then its retained download is self-verifying and remains available after reload', async ({ page }) => {
    const year = 2026; const exportPage = new GobdExportPage(page); const periodId = await exportPage.configure(year); const record = await exportPage.create(periodId)
    await exportPage.downloadAndVerify(record.id, year); await exportPage.reloadKeepsDownload(record.id)
  })
})
