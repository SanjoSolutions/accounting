export class ReceivablesReminderError extends Error {}

export type ReminderEligibility = {
  tenantId: string
  openItemTenantId: string
  direction: string
  kind: string
  documentStatus: string
  status: string
  dueDate: string
  issuedOn: string
  originalAmountCents: number
  allocatedAmountCents: number
}

const isoDate = /^\d{4}-\d{2}-\d{2}$/
export function calendarDate(value: string, label: string) {
  const date = new Date(`${value}T00:00:00.000Z`)
  if (!isoDate.test(value) || Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) throw new ReceivablesReminderError(`${label} must be a real ISO calendar date.`)
  return date
}

export function assertReminderEligible(input: ReminderEligibility) {
  if (input.tenantId !== input.openItemTenantId) throw new ReceivablesReminderError('The open item does not belong to this tenant.')
  if (input.direction !== 'RECEIVABLE' || input.kind !== 'INVOICE') throw new ReceivablesReminderError('Only customer invoice receivables can be reminded.')
  if (!['FINAL', 'POSTED'].includes(input.documentStatus)) throw new ReceivablesReminderError('Only final or posted customer invoices can be reminded.')
  if (!['OPEN', 'PARTIAL'].includes(input.status)) throw new ReceivablesReminderError('Settled open items cannot be reminded.')
  const remaining = input.originalAmountCents - input.allocatedAmountCents
  if (!Number.isSafeInteger(remaining) || remaining <= 0) throw new ReceivablesReminderError('The receivable has no positive remaining amount.')
  if (calendarDate(input.dueDate, 'Original due date') >= calendarDate(input.issuedOn, 'Reminder issue date')) throw new ReceivablesReminderError('The receivable is not overdue on the reminder issue date.')
  return remaining
}

export function nextReminderLevel(existingLevels: number[]) {
  if (existingLevels.some(level => !Number.isSafeInteger(level) || level < 1)) throw new ReceivablesReminderError('Stored reminder levels are invalid.')
  return (existingLevels.length ? Math.max(...existingLevels) : 0) + 1
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)

export function normalizeReminderRecipient(value: string) {
  const recipient = value?.normalize('NFKC').trim().toLowerCase()
  if (!recipient || recipient.length > 254 || /[\r\n]/.test(recipient) || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(recipient)) throw new ReceivablesReminderError('A valid explicit customer email address is required.')
  return recipient
}

export function renderReminderDeliveryContent(input: { invoiceNumber: string; level: number; issuerName: string }) {
  if (!Number.isSafeInteger(input.level) || input.level < 1) throw new ReceivablesReminderError('A valid reminder level is required for delivery.')
  const invoiceNumber = input.invoiceNumber.normalize('NFKC').trim().replace(/[\r\n\t]+/g, ' ')
  const issuerName = input.issuerName.normalize('NFKC').trim().replace(/[\r\n\t]+/g, ' ')
  if (!invoiceNumber || !issuerName || invoiceNumber.length > 160 || issuerName.length > 200) throw new ReceivablesReminderError('The immutable reminder and issuer identity are required for safe delivery.')
  const subject = `Zahlungserinnerung zu Rechnung ${invoiceNumber}`
  const textBody = `${issuerName} hat eine Zahlungserinnerung der Stufe ${input.level} zur Rechnung ${invoiceNumber} erstellt. Die unveränderliche Zahlungserinnerung ist als HTML-Datei beigefügt.`
  const htmlBody = `<!doctype html><html lang="de"><head><meta charset="utf-8"></head><body><p><strong>${escapeHtml(issuerName)}</strong> hat eine Zahlungserinnerung der Stufe ${input.level} zur Rechnung <strong>${escapeHtml(invoiceNumber)}</strong> erstellt.</p><p>Die unveränderliche Zahlungserinnerung ist als HTML-Datei beigefügt.</p></body></html>`
  return { subject, textBody, htmlBody }
}

export function renderReminderHtml(input: { level: number; issuedOn: string; paymentDueDate: string; originalDueDate: string; remainingAmountCents: number; currency: string; invoiceNumber: string; partnerName: string; issuerName: string }) {
  const amount = new Intl.NumberFormat('de-DE', { style: 'currency', currency: input.currency }).format(input.remainingAmountCents / 100)
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Zahlungserinnerung ${escapeHtml(input.invoiceNumber)}</title><style>body{font:16px system-ui;max-width:760px;margin:48px auto;line-height:1.5}h1{font-size:28px}.meta{color:#555}</style></head><body><header><strong>${escapeHtml(input.issuerName)}</strong></header><main><h1>Zahlungserinnerung Stufe ${input.level}</h1><p>${escapeHtml(input.partnerName)},</p><p>zur Rechnung <strong>${escapeHtml(input.invoiceNumber)}</strong> mit Fälligkeit ${escapeHtml(input.originalDueDate)} ist noch ein Betrag von <strong>${escapeHtml(amount)}</strong> offen.</p><p>Bitte zahlen Sie bis ${escapeHtml(input.paymentDueDate)}.</p><p class="meta">Erstellt am ${escapeHtml(input.issuedOn)}. Dieses Dokument wurde zur manuellen Versendung erzeugt. Es wurde keine E-Mail versandt und kein gerichtliches Mahnverfahren eingeleitet.</p></main></body></html>`
}
