import { expect, type Page } from '@playwright/test'

export class DocumentExtractionPage {
  private structuredDocumentId = ''
  constructor(private readonly page: Page) {}

  async signUp(name: string, email: string, password: string) {
    await this.page.goto('/sign-up')
    await this.page.context().addCookies([{ name: 'NEXT_LOCALE', value: 'en', url: new URL(this.page.url()).origin }])
    await this.page.reload()
    await this.page.getByLabel('Name').fill(name)
    await this.page.getByLabel('Email').fill(email)
    await this.page.getByLabel('Password').fill(password)
    await this.page.getByRole('button', { name: 'Create account', exact: true }).click()
    await expect(this.page).toHaveURL('/')
  }

  async uploadAndExtract(pdf: Buffer) {
    await this.page.goto('/bookings')
    await expect(this.page.getByRole('combobox', { name: 'Account row 1' })).toBeEnabled()
    await this.page.locator('.document-actions input[type="file"]').setInputFiles({ name: 'text-layer-invoice.pdf', mimeType: 'application/pdf', buffer: pdf })
    await expect(this.page.getByRole('button', { name: 'text-layer-invoice' })).toHaveAttribute('aria-pressed', 'true')
    await this.page.getByRole('button', { name: 'Extract invoice data' }).click()
    await expect(this.page.getByLabel('Extracted invoice number')).toHaveValue('E2E-2026-001')
    await expect(this.page.getByLabel('Extracted net amount')).toHaveValue('100.00')
    await expect(this.page.getByLabel('Extracted tax amount')).toHaveValue('19.00')
    await expect(this.page.getByLabel('Extracted gross amount')).toHaveValue('119.00')
    await expect(this.page.getByText(/Source: local-pdf-text v1/)).toBeVisible()
  }

  async reviewAndProveDurability() {
    await this.page.getByLabel('Extracted supplier').fill('Reviewed Example Supplier GmbH')
    await this.page.getByRole('button', { name: 'Confirm reviewed invoice' }).click()
    await expect(this.page.getByText('Confirmed', { exact: true })).toBeVisible()
    await this.page.reload()
    await expect(this.page.getByText('Confirmed', { exact: true })).toBeVisible()
    await expect(this.page.getByLabel('Extracted supplier')).toHaveValue('Reviewed Example Supplier GmbH')
    await expect(this.page.getByLabel('Extracted supplier')).toBeDisabled()
  }

  async confirmAndPostPayable() {
    await this.page.getByLabel('Extracted supplier').fill('Reviewed Example Supplier GmbH')
    await this.page.getByRole('button', { name: 'Confirm reviewed invoice' }).click()
    await expect(this.page.getByRole('heading', { name: 'Post supplier invoice' })).toBeVisible()
    await expect(this.page.getByLabel('Expense account')).toHaveValue(/.+/)
    await this.page.getByLabel('Due date').fill('2026-08-06')
    await this.page.getByLabel('Posting confirmation reason').fill('Reviewed PDF facts and confirmed office-supplies account')
    await this.page.getByRole('button', { name: 'Confirm and post payable' }).click()
    await expect(this.page.getByRole('status')).toContainText('E2E-2026-001')
  }

  async provePayableAndJournalAfterReload() {
    await this.page.goto('/receivables')
    const item = this.page.getByRole('row').filter({ hasText: 'E2E-2026-001' })
    await expect(item).toContainText('Reviewed Example Supplier GmbH')
    await expect(item).toContainText('119.00')
    await expect(item).toContainText('OPEN')
    await this.page.reload(); await expect(this.page.getByRole('row').filter({ hasText: 'E2E-2026-001' })).toBeVisible()

    await this.page.goto('/journal?year=2026')
    const entry = this.page.locator('.journal-entry').filter({ hasText: 'Reviewed Example Supplier GmbH: E2E-2026-001' })
    await expect(entry).toContainText('4930')
    await expect(entry).toContainText('Soll 100,00')
    await expect(entry).toContainText('1576')
    await expect(entry).toContainText('Soll 19,00')
    await expect(entry).toContainText('1600')
    await expect(entry).toContainText('Haben 119,00')
    await expect(entry.getByRole('link', { name: 'text-layer-invoice.pdf' })).toBeVisible()
    await this.page.reload(); await expect(this.page.locator('.journal-entry').filter({ hasText: 'E2E-2026-001' })).toBeVisible()
  }

  async uploadReviewAndPostStructuredInvoice(xml: Buffer) {
    await this.page.goto('/bookings')
    await expect(this.page.getByRole('combobox', { name: 'Account row 1' })).toBeEnabled()
    await this.page.locator('.document-actions input[type="file"]').setInputFiles({ name: 'mixed-input.xml', mimeType: 'application/xml', buffer: xml })
    await expect(this.page.getByRole('button', { name: 'mixed-input' })).toHaveAttribute('aria-pressed', 'true')
    await expect(this.page.getByText('Needs review', { exact: true })).toBeVisible()
    await expect(this.page.getByLabel('Extracted invoice number')).toHaveValue('UBL-MIXED-E2E')
    await expect(this.page.getByLabel('Extracted net amount')).toHaveValue('200.00')
    await expect(this.page.getByLabel('Extracted tax amount')).toHaveValue('26.00')
    await expect(this.page.getByLabel('Extracted supplier')).toBeDisabled()
    await this.page.getByRole('button', { name: 'Confirm reviewed invoice' }).click()
    await expect(this.page.getByRole('heading', { name: 'Post supplier invoice' })).toBeVisible()
    await this.page.getByLabel('Due date').fill('2026-08-07')
    await this.page.getByLabel('Posting confirmation reason').fill('Reviewed authoritative mixed-rate UBL')
    await this.page.getByRole('button', { name: 'Confirm and post payable' }).click()
    await expect(this.page.getByRole('status')).toContainText('UBL-MIXED-E2E')
  }

  async uploadReviewAndPostStructured(file: { name: string; mimeType: string; buffer: Buffer }, invoiceNumber: string, net: string, tax: string) {
    await this.page.goto('/bookings')
    await expect(this.page.getByRole('combobox', { name: 'Account row 1' })).toBeEnabled()
    const uploaded = this.page.waitForResponse(response => response.url().endsWith('/api/documents') && response.request().method() === 'POST')
    await this.page.locator('.document-actions input[type="file"]').setInputFiles(file)
    const response = await uploaded; const body = await response.json(); this.structuredDocumentId = body.data.id
    await expect(this.page.getByText('Needs review', { exact: true })).toBeVisible()
    await expect(this.page.getByLabel('Extracted invoice number')).toHaveValue(invoiceNumber)
    await expect(this.page.getByLabel('Extracted net amount')).toHaveValue(net)
    await expect(this.page.getByLabel('Extracted tax amount')).toHaveValue(tax)
    await expect(this.page.getByLabel('Extracted supplier')).toBeDisabled()
    await this.page.getByRole('button', { name: 'Confirm reviewed invoice' }).click()
    await expect(this.page.getByRole('heading', { name: 'Post supplier invoice' })).toBeVisible()
    await this.page.getByLabel('Due date').fill('2026-08-07')
    await this.page.getByLabel('Posting confirmation reason').fill(`Reviewed authoritative ${file.name}`)
    await this.page.getByRole('button', { name: 'Confirm and post payable' }).click()
    await expect(this.page.getByRole('status')).toContainText(invoiceNumber)
  }

  async uploadReviewAndPostReverseChargeUbl(xml: Buffer) {
    await this.page.goto('/bookings')
    await expect(this.page.getByRole('combobox', { name: 'Account row 1' })).toBeEnabled()
    const uploaded = this.page.waitForResponse(response => response.url().endsWith('/api/documents') && response.request().method() === 'POST')
    await this.page.locator('.document-actions input[type="file"]').setInputFiles({ name: 'domestic-13b.xml', mimeType: 'application/xml', buffer: xml })
    const body = await (await uploaded).json(); this.structuredDocumentId = body.data.id
    await expect(this.page.getByText('Needs review', { exact: true })).toBeVisible()
    await expect(this.page.getByLabel('Extracted invoice number')).toHaveValue('UBL-RC-E2E')
    await expect(this.page.getByLabel('Extracted net amount')).toHaveValue('100.00')
    await expect(this.page.getByLabel('Extracted tax amount')).toHaveValue('0.00')
    await expect(this.page.getByLabel('Extracted gross amount')).toHaveValue('100.00')
    await this.page.getByRole('button', { name: 'Confirm reviewed invoice' }).click()
    await expect(this.page.getByRole('heading', { name: 'Post supplier invoice' })).toBeVisible()
    await expect(this.page.getByText('Domestic §13b reverse charge', { exact: true })).toBeVisible()
    await expect(this.page.getByRole('button', { name: 'Confirm and post payable' })).toBeDisabled()
    await this.page.getByLabel('Recipient-assessed VAT rate').selectOption('1900')
    await this.page.getByLabel('Due date').fill('2026-08-09')
    await this.page.getByLabel('Posting confirmation reason').fill('Confirmed domestic §13b UStG construction service and 19% assessment')
    await expect(this.page.getByRole('button', { name: 'Confirm and post payable' })).toBeEnabled()
    await this.page.getByRole('button', { name: 'Confirm and post payable' }).click()
    await expect(this.page.getByRole('status')).toContainText('UBL-RC-E2E')
  }

  async proveReverseChargePayableAfterReload() {
    await this.page.goto('/receivables')
    const item = this.page.getByRole('row').filter({ hasText: 'UBL-RC-E2E' })
    await expect(item).toContainText('German Construction Supplier GmbH'); await expect(item).toContainText('100.00'); await expect(item).toContainText('OPEN')
    await this.page.goto('/journal?year=2026')
    const entry = this.page.locator('.journal-entry').filter({ hasText: 'German Construction Supplier GmbH: UBL-RC-E2E' })
    await expect(entry).toContainText('4930'); await expect(entry).toContainText('Soll 100,00')
    await expect(entry).toContainText('1577'); await expect(entry).toContainText('Soll 19,00')
    await expect(entry).toContainText('1787'); await expect(entry).toContainText('Haben 19,00')
    await expect(entry).toContainText('1600'); await expect(entry).toContainText('Haben 100,00')
    await expect(entry.getByRole('link', { name: 'domestic-13b.xml' })).toBeVisible()
    await this.page.reload(); await expect(this.page.locator('.journal-entry').filter({ hasText: 'UBL-RC-E2E' })).toBeVisible()
    const context = await this.page.evaluate(async documentId => (await fetch(`/api/documents/${documentId}/payable-posting`)).json(), this.structuredDocumentId)
    const vatPosting = context.data.posting.postingJournalEntry.lines.flatMap((line: { vatPosting: unknown }) => line.vatPosting ? [line.vatPosting] : [])[0]
    expect(vatPosting).toMatchObject({ ruleId: 'DE_13B', rateBasisPoints: 1900, netBaseCents: 10_000, outputTaxCents: 1_900, inputTaxCents: 1_900, documentId: this.structuredDocumentId })
    expect(JSON.parse(vatPosting.returnBoxes)).toEqual([{ box: '84', direction: 'purchase', value: 'net-base' }, { box: '85', direction: 'purchase', value: 'output-tax' }, { box: '67', direction: 'purchase', value: 'input-tax' }])
  }

  async uploadReviewAndPostEuServiceReverseChargeUbl(xml: Buffer) {
    await this.page.goto('/bookings')
    const uploaded = this.page.waitForResponse(response => response.url().endsWith('/api/documents') && response.request().method() === 'POST')
    await this.page.locator('.document-actions input[type="file"]').setInputFiles({ name: 'austrian-cloud-service.xml', mimeType: 'application/xml', buffer: xml })
    const body = await (await uploaded).json(); this.structuredDocumentId = body.data.id
    await expect(this.page.getByLabel('Extracted invoice number')).toHaveValue('EU-SVC-AT-E2E')
    await expect(this.page.getByLabel('Extracted gross amount')).toHaveValue('100.00')
    await this.page.getByRole('button', { name: 'Confirm reviewed invoice' }).click()
    await expect(this.page.getByText('EU supplier service reverse charge', { exact: true })).toBeVisible()
    await expect(this.page.getByText(/KZ 46\/47.*KZ 67/)).toBeVisible()
    await expect(this.page.getByRole('button', { name: 'Confirm and post payable' })).toBeDisabled()
    await this.page.getByLabel('Supply classification').selectOption('SERVICE')
    await this.page.getByLabel('Recipient-assessed VAT rate').selectOption('1900')
    await this.page.getByLabel('Due date').fill('2026-08-09')
    await this.page.getByLabel('Posting confirmation reason').fill('Confirmed Austrian B2B cloud service under §13b(1) and Article 196 at 19%')
    await this.page.getByRole('button', { name: 'Confirm and post payable' }).click()
    await expect(this.page.getByRole('status')).toContainText('EU-SVC-AT-E2E')
  }

  async proveEuServiceReverseChargeAfterReload() {
    await this.page.goto('/receivables')
    const item = this.page.getByRole('row').filter({ hasText: 'EU-SVC-AT-E2E' })
    await expect(item).toContainText('Vienna Cloud GmbH'); await expect(item).toContainText('100.00'); await expect(item).toContainText('OPEN')
    await this.page.goto('/journal?year=2026')
    const entry = this.page.locator('.journal-entry').filter({ hasText: 'Vienna Cloud GmbH: EU-SVC-AT-E2E' })
    await expect(entry).toContainText('4930'); await expect(entry).toContainText('Soll 100,00')
    await expect(entry).toContainText('1577'); await expect(entry).toContainText('Soll 19,00')
    await expect(entry).toContainText('1787'); await expect(entry).toContainText('Haben 19,00')
    await expect(entry).toContainText('1600'); await expect(entry).toContainText('Haben 100,00')
    await expect(entry.getByRole('link', { name: 'austrian-cloud-service.xml' })).toBeVisible()
    await this.page.reload(); await expect(this.page.locator('.journal-entry').filter({ hasText: 'EU-SVC-AT-E2E' })).toBeVisible()
    const context = await this.page.evaluate(async documentId => (await fetch(`/api/documents/${documentId}/payable-posting`)).json(), this.structuredDocumentId)
    const vat = context.data.posting.postingJournalEntry.lines.flatMap((line: { vatPosting: unknown }) => line.vatPosting ? [line.vatPosting] : [])[0]
    expect(vat).toMatchObject({ ruleId: 'EU_13B_SERVICE_RECIPIENT', taxPoint: '2026-08-01T00:00:00.000Z', netBaseCents: 10_000, outputTaxCents: 1_900, inputTaxCents: 1_900, documentId: this.structuredDocumentId })
    expect(JSON.parse(vat.returnBoxes)).toEqual([{ box: '46', direction: 'purchase', value: 'net-base' }, { box: '47', direction: 'purchase', value: 'output-tax' }, { box: '67', direction: 'purchase', value: 'input-tax' }])
  }

  async uploadReviewAndPostEuGoodsAcquisitionUbl(xml: Buffer) {
    await this.page.goto('/bookings')
    const uploaded = this.page.waitForResponse(response => response.url().endsWith('/api/documents') && response.request().method() === 'POST')
    await this.page.locator('.document-actions input[type="file"]').setInputFiles({ name: 'dutch-goods-acquisition.xml', mimeType: 'application/xml', buffer: xml })
    const body = await (await uploaded).json(); this.structuredDocumentId = body.data.id
    await expect(this.page.getByLabel('Extracted invoice number')).toHaveValue('NL-2026-0042')
    await expect(this.page.getByLabel('Extracted gross amount')).toHaveValue('100.00')
    await this.page.getByRole('button', { name: 'Confirm reviewed invoice' }).click()
    await expect(this.page.getByText('Intra-EU acquisition of goods', { exact: true })).toBeVisible()
    await expect(this.page.getByText(/KZ 89.*KZ 61/)).toBeVisible()
    await expect(this.page.getByRole('button', { name: 'Confirm and post payable' })).toBeDisabled()
    await this.page.getByLabel('Supply classification').selectOption('STANDARD_GOODS')
    await this.page.getByLabel('Recipient-assessed VAT rate').selectOption('1900')
    await this.page.getByLabel('Due date').fill('2026-08-17')
    await this.page.getByLabel('Posting confirmation reason').fill('Confirmed Dutch ordinary goods delivered to Germany and used wholly for taxable business activity at 19%')
    await this.page.getByRole('button', { name: 'Confirm and post payable' }).click()
    await expect(this.page.getByRole('status')).toContainText('NL-2026-0042')
  }

  async proveEuGoodsAcquisitionAfterReload() {
    await this.page.goto('/receivables')
    const item = this.page.getByRole('row').filter({ hasText: 'NL-2026-0042' })
    await expect(item).toContainText('Holland Waren B.V.'); await expect(item).toContainText('100.00'); await expect(item).toContainText('OPEN')
    await this.page.goto('/journal?year=2026')
    const entry = this.page.locator('.journal-entry').filter({ hasText: 'Holland Waren B.V.: NL-2026-0042' })
    await expect(entry).toContainText('4930'); await expect(entry).toContainText('Soll 100,00')
    await expect(entry).toContainText('1574'); await expect(entry).toContainText('Soll 19,00')
    await expect(entry).toContainText('1774'); await expect(entry).toContainText('Haben 19,00')
    await expect(entry).toContainText('1600'); await expect(entry).toContainText('Haben 100,00')
    await expect(entry.getByRole('link', { name: 'dutch-goods-acquisition.xml' })).toBeVisible()
    await this.page.reload(); await expect(this.page.locator('.journal-entry').filter({ hasText: 'NL-2026-0042' })).toBeVisible()
    const context = await this.page.evaluate(async documentId => (await fetch(`/api/documents/${documentId}/payable-posting`)).json(), this.structuredDocumentId)
    const vat = context.data.posting.postingJournalEntry.lines.flatMap((line: { vatPosting: unknown }) => line.vatPosting ? [line.vatPosting] : [])[0]
    expect(vat).toMatchObject({ ruleId: 'EU_ACQUISITION', taxPoint: '2026-08-03T00:00:00.000Z', netBaseCents: 10_000, outputTaxCents: 1_900, inputTaxCents: 1_900, documentId: this.structuredDocumentId })
    expect(JSON.parse(vat.returnBoxes)).toEqual([{ box: '89', direction: 'purchase', value: 'net-base' }, { box: '61', direction: 'purchase', value: 'input-tax' }])
  }

  async proveStructuredPayableAfterReload(input: { invoiceNumber: string; supplier: string; gross: string; fileName: string; inputVatAccount: string; inputVat: string; vatRule: string }) {
    await this.page.goto('/receivables')
    const item = this.page.getByRole('row').filter({ hasText: input.invoiceNumber })
    await expect(item).toContainText(input.supplier); await expect(item).toContainText(input.gross); await expect(item).toContainText('OPEN')
    await this.page.reload(); await expect(this.page.getByRole('row').filter({ hasText: input.invoiceNumber })).toBeVisible()
    await this.page.goto('/journal?year=2026')
    const entry = this.page.locator('.journal-entry').filter({ hasText: `${input.supplier}: ${input.invoiceNumber}` })
    await expect(entry).toContainText(input.inputVatAccount); await expect(entry).toContainText(input.inputVat)
    await expect(entry).toContainText('1600'); await expect(entry.getByRole('link', { name: input.fileName })).toBeVisible()
    await this.page.reload(); await expect(this.page.locator('.journal-entry').filter({ hasText: input.invoiceNumber })).toBeVisible()
    const context = await this.page.evaluate(async documentId => (await fetch(`/api/documents/${documentId}/payable-posting`)).json(), this.structuredDocumentId)
    expect(context.data.posting.businessPartner.name).toBe(input.supplier)
    expect(context.data.posting.openItem.status).toBe('OPEN')
    expect(context.data.posting.postingJournalEntry.documents).toEqual(expect.arrayContaining([expect.objectContaining({ documentId: this.structuredDocumentId })]))
    expect(context.data.posting.postingJournalEntry.lines.flatMap((line: { vatPosting: null | { ruleId: string } }) => line.vatPosting ? [line.vatPosting.ruleId] : [])).toContain(input.vatRule)
  }

  async proveStructuredMixedPayableAfterReload() {
    await this.page.goto('/receivables')
    const item = this.page.getByRole('row').filter({ hasText: 'UBL-MIXED-E2E' })
    await expect(item).toContainText('Mixed UBL Supplier GmbH')
    await expect(item).toContainText('226.00')
    await this.page.goto('/journal?year=2026')
    const entry = this.page.locator('.journal-entry').filter({ hasText: 'Mixed UBL Supplier GmbH: UBL-MIXED-E2E' })
    await expect(entry).toContainText('1571')
    await expect(entry).toContainText('Soll 7,00')
    await expect(entry).toContainText('1576')
    await expect(entry).toContainText('Soll 19,00')
    await expect(entry).toContainText('1600')
    await expect(entry).toContainText('Haben 226,00')
    await expect(entry.getByRole('link', { name: 'mixed-input.xml' })).toBeVisible()
    await this.page.reload(); await expect(this.page.locator('.journal-entry').filter({ hasText: 'UBL-MIXED-E2E' })).toBeVisible()
  }

  async uploadAndPostSupplierCredit(xml: Buffer) {
    await this.page.goto('/bookings')
    const uploaded = this.page.waitForResponse(response => response.url().endsWith('/api/documents') && response.request().method() === 'POST')
    await this.page.locator('.document-actions input[type="file"]').setInputFiles({ name: 'supplier-credit.xml', mimeType: 'application/xml', buffer: xml })
    const body = await (await uploaded).json(); this.structuredDocumentId = body.data.id
    await expect(this.page.getByRole('heading', { name: 'Post supplier credit note' })).toBeVisible()
    await expect(this.page.getByText('UBL GS-MIXED-E2E')).toBeVisible()
    await expect(this.page.getByText(/ER-MIXED-E2E.*Mixed Credit Supplier GmbH/)).toBeVisible()
    await this.page.getByLabel('Adjustment-effective date').fill('2026-08-04')
    await this.page.getByLabel('Posting confirmation reason').fill('Reviewed exact UBL supplier credit and effective date')
    await this.page.getByRole('button', { name: 'Confirm and post supplier credit' }).click()
    await expect(this.page.getByRole('status')).toContainText('GS-MIXED-E2E')
    await expect(this.page.getByRole('status')).toContainText('unapplied supplier credit: €0.00')
  }

  async proveSupplierCreditAfterReload() {
    await this.page.goto('/receivables')
    const credit = this.page.getByRole('row').filter({ hasText: 'GS-MIXED-E2E' })
    await expect(credit).toContainText('Mixed Credit Supplier GmbH'); await expect(credit).toContainText('226.00'); await expect(credit).toContainText('SETTLED')
    await this.page.reload(); await expect(this.page.getByRole('row').filter({ hasText: 'GS-MIXED-E2E' })).toBeVisible()
    await this.page.goto('/journal?year=2026')
    const entry = this.page.locator('.journal-entry').filter({ hasText: 'Supplier credit note GS-MIXED-E2E for ER-MIXED-E2E' })
    await expect(entry).toContainText('1600'); await expect(entry).toContainText('Soll 226,00')
    await expect(entry).toContainText('4930'); await expect(entry).toContainText('Haben 100,00')
    await expect(entry).toContainText('1571'); await expect(entry).toContainText('Haben 7,00')
    await expect(entry).toContainText('1576'); await expect(entry).toContainText('Haben 19,00')
    await expect(entry.getByRole('link', { name: 'supplier-credit.xml' })).toBeVisible()
    await this.page.reload(); await expect(this.page.locator('.journal-entry').filter({ hasText: 'GS-MIXED-E2E' })).toBeVisible()
    const context = await this.page.evaluate(async documentId => (await fetch(`/api/documents/${documentId}/payable-credit-note`)).json(), this.structuredDocumentId)
    expect(context.data.correction).toMatchObject({ direction: 'PAYABLE', kind: 'CREDIT_NOTE', status: 'POSTED', openItem: { side: 'DEBIT', status: 'SETTLED' }, correctionNetting: { amountCents: 22_600 } })
    expect(context.data.correction.postingJournalEntry.lines.flatMap((line: { vatPosting: null | { netBaseCents: number; inputTaxCents: number } }) => line.vatPosting ? [line.vatPosting] : [])).toEqual(expect.arrayContaining([expect.objectContaining({ netBaseCents: -10_000, inputTaxCents: -700 }), expect.objectContaining({ netBaseCents: -10_000, inputTaxCents: -1_900 })]))
  }
}
