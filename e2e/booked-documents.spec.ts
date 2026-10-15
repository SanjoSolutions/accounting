import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { BookedDocumentsPage } from './booked-documents-page'

test('Given a previously booked receipt, when it is selected again and posted, then both journal links survive and the inbox stays unchanged', async ({ page }) => {
  const library = new BookedDocumentsPage(page)
  await library.open()
  const uploaded = page.waitForResponse(response => response.url().endsWith('/api/documents') && response.request().method() === 'POST')
  await library.picker.locator('input[type="file"]').setInputFiles({
    name: 'Synthetic-reusable-receipt.pdf', mimeType: 'application/pdf',
    buffer: readFileSync(new URL('./fixtures/invoice.pdf', import.meta.url)),
  })
  const upload = await uploaded
  expect(upload.status()).toBe(201)
  const document = (await upload.json()).data
  const uploadedCard = library.picker.getByRole('button', { name: 'Synthetic-reusable-receipt', exact: true })
  await expect(uploadedCard).toHaveAttribute('aria-pressed', 'true')
  await uploadedCard.click({ modifiers: ['Shift'] })
  await expect(uploadedCard).toHaveAttribute('aria-pressed', 'false')
  const workspace = await (await page.request.get('/api/booking-records?year=2026')).json()
  const originalDescription = 'Synthetic original booking'
  const draftResponse = await page.request.post('/api/booking-records', { data: {
    fiscalYear: 2026, bookingDate: '2026-02-01', description: originalDescription, documentIds: [document.id],
    lines: [
      { accountId: workspace.accounts.find((account: { number: number }) => account.number === 4930).id, debitCents: 1000, creditCents: 0 },
      { accountId: workspace.accounts.find((account: { number: number }) => account.number === 1200).id, debitCents: 0, creditCents: 1000 },
    ],
  } })
  expect(draftResponse.status(), await draftResponse.text()).toBe(201)
  const draft = await draftResponse.json()
  const postedResponse = await page.request.post(`/api/booking-batches/${draft.id}/post`, { data: { reason: 'Synthetic fixture approved' } })
  expect(postedResponse.status(), await postedResponse.text()).toBe(200)

  // Simulate posting in another editor while this picker still has the upload
  // cached. A fresh inbox request must discard that now-booked result.
  await library.view.selectOption('booked')
  await expect(library.picker.getByRole('link').filter({ hasText: originalDescription })).toBeVisible()
  await library.view.selectOption('inbox')
  await library.chooseBooked('Synthetic-reusable-receipt', originalDescription)
  await page.screenshot({ path: '.playwright/issue-23-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: '.playwright/issue-23-mobile.png', fullPage: true })
  await page.setViewportSize({ width: 1280, height: 900 })
  await library.view.selectOption('inbox')
  await expect(library.picker.getByRole('button', { name: 'Synthetic-reusable-receipt', exact: true })).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'Synthetic-reusable-receipt' })).toHaveAttribute('aria-selected', 'true')

  const reusedDescription = 'Synthetic reuse booking'
  await library.saveDraft(reusedDescription)
  await library.postDraft(reusedDescription)
  const booked = (await (await page.request.get('/api/documents?view=booked')).json()).data.find((item: { id: string }) => item.id === document.id)
  expect(booked.bookings.map((entry: { description: string }) => entry.description)).toEqual([reusedDescription, originalDescription])
  expect((await (await page.request.get('/api/documents')).json()).data).toEqual([])
  await library.open()
  await library.view.selectOption('booked')
  await expect(library.picker.getByRole('link').filter({ hasText: originalDescription })).toBeVisible()
  await expect(library.picker.getByRole('link').filter({ hasText: reusedDescription })).toBeVisible()
})
