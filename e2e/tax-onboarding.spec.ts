import { expect, test } from '@playwright/test'
import { StructuredInvoicesPage } from './structured-invoices-page'
import { InvoiceNumberingPage } from './invoice-numbering-page'

test('Given an administrator and imported numbering, when onboarding and a legacy migration are confirmed, then immutable reconciliation survives retries and reload', async ({ page }, testInfo) => {
  await new StructuredInvoicesPage(page).signUp('Onboarding Admin', `onboarding-${Date.now()}@example.test`, 'Synthetic-onboarding-password-2026!')
  const numbering = new InvoiceNumberingPage(page)
  await numbering.open()
  await numbering.fill(2026, 42, ['2026-000040', '2026-000041'])
  await numbering.proveConfirmationTracksInputs()
  await page.screenshot({ path: testInfo.outputPath('onboarding-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await numbering.section.screenshot({ path: testInfo.outputPath('onboarding-mobile.png') })
  await page.setViewportSize({ width: 1280, height: 900 })
  await numbering.confirmAndSave(testInfo.outputPath('onboarding-busy.png'))
  await numbering.expectReconciled(2026, 42)

  const retry = await page.request.post('/api/tax/e-invoices', { data: {
    action: 'reconcile-number-sequence', year: 2026, firstUnusedNumber: 42,
    importedInvoiceNumbers: ['2026-000041', '2026-000040'], confirmedExistingSeries: true,
  } })
  expect(retry.status()).toBe(201)
  expect((await retry.json()).data.nextValue).toBe(42)
  const readiness = await page.request.get('/api/tax/readiness?kind=USTVA&period=2026-01')
  expect((await readiness.json()).data.checks).toContainEqual({ id: 'invoice-sequence', ready: true, issues: [] })
  await page.reload()
  await numbering.expectReconciled(2026, 42)

  const legacy = await page.request.post('/api/tax/e-invoices', { data: { action: 'configure-number-sequence', year: 2025, firstUnusedNumber: 10, confirmedExistingSeries: true } })
  expect(legacy.status()).toBe(201)
  await page.reload()
  await expect(numbering.section.getByRole('listitem').filter({ hasText: '2025: next number 10.' })).toContainText('Reconciliation required')
  await numbering.fill(2025, 10, ['2025-000009'])
  await numbering.confirmAndSave()
  await numbering.expectReconciled(2025, 10)
  await page.screenshot({ path: testInfo.outputPath('onboarding-complete.png') })
})
