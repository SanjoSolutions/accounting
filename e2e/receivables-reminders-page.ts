import { readFile } from 'node:fs/promises'
import { expect, type Page } from '@playwright/test'

export class ReceivablesRemindersPage {
  constructor(private readonly page: Page) {}

  async openAndIssue(invoiceNumber: string) {
    await this.page.getByRole('link', { name: 'Customers & open items' }).click()
    await expect(this.page).toHaveURL('/receivables')
    const openItem = this.page.getByRole('row', { name: new RegExp(`${invoiceNumber}.*Kunde GmbH.*€119.00.*€119.00.*OPEN`) })
    await expect(openItem).toBeVisible(); await openItem.getByRole('button', { name: 'Issue reminder' }).click()
    await expect(this.page.getByRole('status')).toContainText('Reminder level 1 was issued')
    const reminder = this.page.getByRole('row', { name: new RegExp(`${invoiceNumber}.*1.*€119.00.*Active`) })
    await expect(reminder).toBeVisible()

    const [printable] = await Promise.all([this.page.context().waitForEvent('page'), reminder.getByRole('link', { name: 'Open printable copy' }).click()])
    await expect(printable.getByRole('heading', { name: 'Zahlungserinnerung Stufe 1' })).toBeVisible()
    await expect(printable.locator('body')).toContainText('Es wurde keine E-Mail versandt und kein gerichtliches Mahnverfahren eingeleitet.'); await printable.close()

    const downloadPromise = this.page.waitForEvent('download'); await reminder.getByRole('link', { name: 'Download' }).click(); const download = await downloadPromise
    const path = await download.path(); expect(path).toBeTruthy(); expect(await readFile(path!, 'utf8')).toContain(`Rechnung <strong>${invoiceNumber}</strong>`)
  }

  async approveAndDeliver(invoiceNumber: string, recipient: string) {
    const reminder = this.page.getByRole('row', { name: new RegExp(`${invoiceNumber}.*1.*€119.00.*Active`) })
    await reminder.getByRole('button', { name: 'Prepare email delivery' }).click()
    await expect(reminder.getByLabel('Reviewed customer email')).toHaveValue('')
    await reminder.getByLabel('Reviewed customer email').fill(recipient)
    await reminder.getByLabel('Approval reason').fill('Reviewed against the customer billing instruction')
    await reminder.getByLabel('I reviewed this exact recipient and approve sending the issued reminder.').check()
    await reminder.getByRole('button', { name: 'Send reminder email' }).click()
    await expect(this.page.getByRole('status')).toContainText(`delivered to ${recipient}`)
    const delivered = this.page.getByRole('row', { name: new RegExp(`${invoiceNumber}.*${recipient}.*Sent.*Provider message ID: local-email-`) })
    await expect(delivered).toBeVisible()

    const response = await this.page.request.get(`http://127.0.0.1:3200/captures?recipient=${encodeURIComponent(recipient)}`)
    expect(response.ok()).toBe(true); const captures = (await response.json()).captures
    expect(captures).toHaveLength(1); expect(captures[0].body.message).toMatchObject({ to: [recipient], subject: `Zahlungserinnerung zu Rechnung ${invoiceNumber}` })
    expect(captures[0].body.message.html).toContain('unveränderliche Zahlungserinnerung')
    const attachment = captures[0].body.attachments[0]; expect(attachment.contentType).toBe('text/html; charset=utf-8')
    expect(Buffer.from(attachment.contentBase64, 'base64').toString('utf8')).toContain(`Rechnung <strong>${invoiceNumber}</strong>`)

    await this.page.reload()
    await expect(this.page.getByRole('row', { name: new RegExp(`${invoiceNumber}.*${recipient}.*Sent.*Provider message ID: local-email-`) })).toBeVisible()
    await expect(this.page.getByRole('row', { name: new RegExp(`${invoiceNumber}.*Kunde GmbH.*€119.00.*€119.00.*OPEN`) })).toBeVisible()
  }

  async proveReloadHistoryAndAppendOnlyCancellation(invoiceNumber: string) {
    await this.page.reload()
    const reminder = this.page.getByRole('row', { name: new RegExp(`${invoiceNumber}.*1.*€119.00.*Active`) })
    await expect(reminder).toBeVisible(); await reminder.getByRole('button', { name: 'Cancel reminder' }).click()
    await expect(this.page.getByRole('status')).toContainText('cancelled without deleting its history')
    await expect(this.page.getByRole('row', { name: new RegExp(`${invoiceNumber}.*1.*€119.00.*Cancelled`) })).toBeVisible()
    await expect(this.page.getByRole('row', { name: new RegExp(`${invoiceNumber}.*Kunde GmbH.*€119.00.*€119.00.*OPEN`) })).toBeVisible()
    await this.page.reload(); await expect(this.page.getByRole('row', { name: new RegExp(`${invoiceNumber}.*1.*€119.00.*Cancelled`) })).toBeVisible()
  }
}
