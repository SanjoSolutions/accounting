import { test, expect } from './fixtures'
import { materializeSyntheticLexware2025Directory, syntheticLexware2025 } from './fixtures/lexware-2025'

test.describe.configure({ mode: 'serial' })

test.describe('2025 Lexware demonstrated accounting requirements', () => {
  test('[LEX25-01] imports and presents the 2025 accounting setup', async ({ app, reports, page }) => {
    await app.open('/export-import')
    await page.getByLabel('Select export folder').setInputFiles(await materializeSyntheticLexware2025Directory())
    await expect(page.getByText(/files selected · Lexware Betriebsprüfung/)).toBeVisible()
    await page.getByRole('button', { name: 'Import accounting data' }).click()
    await expect(page.getByRole('status')).toContainText('2025')

    await reports.open2025()
    await reports.expectSectionContains(/Company master data/i, syntheticLexware2025.company, syntheticLexware2025.region)
    await reports.expectSectionContains(/Accounting setup/i, 'EUR', 'SKR03', '2025-01-01', '2025-12-31', '6.8')
  })

  test('[LEX25-02] searches the chart and presents its accounting mappings', async ({ reports }) => {
    await reports.open2025()
    const chart = await reports.searchChart(syntheticLexware2025.chartSearch)
    await expect(chart).toContainText(syntheticLexware2025.chartAccount)
    await expect(chart).toContainText('19')
    await expect(chart).toContainText('Sonstige Betriebsausgaben')
    await expect(chart).toContainText('Sonstige betriebliche Aufwendungen')
    await expect(chart).toContainText('is.netIncome.regular.operatingTC.otherCost')
  })

  test('[LEX25-03] presents a balanced multi-line journal posting and its metadata', async ({ reports }) => {
    await reports.openJournal2025()
    await expect(reports.page.getByText(syntheticLexware2025.attachedBooking)).toBeVisible()
    const posting = reports.page.getByText(syntheticLexware2025.attachedBooking).locator('xpath=ancestor::article[1]')
    await expect(posting).toContainText('SYN-501')
    await expect(posting).toContainText(/120[,.]00/)
    await expect(posting).toContainText(/22[,.]80/)
    await expect(posting).toContainText(/142[,.]80/)
    const outgoing = reports.page.getByText(syntheticLexware2025.outgoingBooking).locator('xpath=ancestor::article[1]')
    await expect(outgoing).toContainText(syntheticLexware2025.outputVatAccount)
    await expect(outgoing).toContainText(/57[,.]00/)

    await reports.open2025()
    await reports.openLedgerAccount(syntheticLexware2025.chartAccount)
    const importedSourceMetadata = reports.section(/General-ledger account sheets/i)
      .locator('details[open] tr')
      .filter({ hasText: syntheticLexware2025.attachedBooking })
    await expect(importedSourceMetadata).toContainText('2025-02-18')
    await expect(importedSourceMetadata).toContainText('2025-02-20')
    await expect(importedSourceMetadata).toContainText('2025-02-14')
    await expect(importedSourceMetadata.getByRole('cell', { name: '2', exact: true })).toBeVisible()
  })

  test('[LEX25-04] retrieves an attached voucher and retains a posting without one', async ({ reports }) => {
    const voucherResponse = await reports.openVoucherFromJournal(syntheticLexware2025.voucher)
    expect(voucherResponse.status()).toBe(200)
    expect(voucherResponse.headers()['content-type']).toContain('application/pdf')
    await expect(reports.page.getByText(syntheticLexware2025.unattachedBooking)).toBeVisible()
  })

  test('[LEX25-05] presents opening, annual, cumulative, and closing trial-balance values', async ({ reports }) => {
    await reports.open2025()
    await reports.expectSectionContains(
      /Trial balance/i,
      syntheticLexware2025.chartAccount, '2025-06-30',
    )
    await expect(reports.section(/Trial balance/i)).toContainText(/10[,.]00/)
    await expect(reports.section(/Trial balance/i)).toContainText(/137[,.]35/)
    await expect(reports.section(/Trial balance/i)).toContainText(/147[,.]35/)
  })

  test('[LEX25-06] drills into a general-ledger account sheet', async ({ reports }) => {
    await reports.open2025()
    await reports.openLedgerAccount(syntheticLexware2025.chartAccount)
    await reports.expectSectionContains(
      /General-ledger account sheets/i,
      '70001', 'SYN-501', syntheticLexware2025.attachedBooking, syntheticLexware2025.inputVatAccount, '19',
    )
    await expect(reports.section(/General-ledger account sheets/i)).toContainText(/120[,.]00/)
  })

  test('[LEX25-07] presents debtor and creditor subledger activity', async ({ reports }) => {
    await reports.open2025()
    await reports.expectSectionContains(
      /Debtors and creditors/i,
      syntheticLexware2025.debtorAccount, syntheticLexware2025.debtor,
      syntheticLexware2025.creditorAccount, syntheticLexware2025.creditor,
    )
    await expect(reports.section(/Debtors and creditors/i)).toContainText(/238[,.]00/)
    await expect(reports.section(/Debtors and creditors/i)).toContainText(/142[,.]80/)
  })

  test('[LEX25-08] presents counterparty address master data', async ({ reports }) => {
    await reports.open2025()
    await reports.expectSectionContains(
      /Debtors and creditors/i,
      'C-10001', syntheticLexware2025.debtor, syntheticLexware2025.street, '11',
      '23456', syntheticLexware2025.city, 'Test retail',
    )
  })

  test('[LEX25-09] presents the imported annual German VAT values', async ({ reports }) => {
    await reports.open2025()
    await reports.expectSectionContains(/Annual VAT statement/i, '81', '83')
    await expect(reports.section(/Annual VAT statement/i)).toContainText(/200[,.]00/)
    await expect(reports.section(/Annual VAT statement/i)).toContainText(/38[,.]00/)
  })

  test('[LEX25-10] imports a Windows-1252 GDPdU folder idempotently', async ({ app, page }) => {
    await app.open('/export-import')
    const directory = await materializeSyntheticLexware2025Directory()
    await page.getByLabel('Select export folder').setInputFiles(directory)
    await page.getByRole('button', { name: 'Import accounting data' }).click()
    await expect(page.getByRole('status')).toContainText('skipped 4 existing bookings')

    await page.getByLabel('Select export folder').setInputFiles(directory)
    await page.getByRole('button', { name: 'Import accounting data' }).click()
    await expect(page.getByRole('status')).toContainText('Processed 0 bookings')
    await expect(page.getByRole('status')).toContainText('skipped 4 existing bookings')
  })
})
