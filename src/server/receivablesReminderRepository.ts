import 'server-only'

import { createHash, randomUUID } from 'node:crypto'
import { assertReminderEligible, calendarDate, nextReminderLevel, normalizeReminderRecipient, ReceivablesReminderError, renderReminderDeliveryContent, renderReminderHtml } from '@/core/receivablesReminder'
import { appendAuditEvent } from '@/server/compliance/auditPersistence'
import { prisma } from '@/server/persistence/client'
import { configuredReminderEmailGateway, type ReminderEmailGateway } from '@/server/reminderEmailGateway'

const required = (value: string, label: string) => { if (!value?.trim()) throw new ReceivablesReminderError(`${label} is required.`); return value.trim() }
const requestKey = (value: string) => { const key = required(value, 'Request key'); if (!/^[A-Za-z0-9._:-]{16,100}$/.test(key)) throw new ReceivablesReminderError('Request key must contain 16-100 safe characters.'); return key }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const isUniqueConflict = (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')

export type IssueReminderInput = { openItemId: string; issuedOn: string; paymentDueDate: string; reason: string }
export type DeliverReminderInput = { recipient: string; reason: string }

export async function issueReceivablesReminder(ownerId: string, actorId: string, durableRequestKey: string, input: IssueReminderInput) {
  required(ownerId, 'ownerId'); required(actorId, 'actorId'); required(input.reason, 'Reason'); const key = requestKey(durableRequestKey)
  const issuedOn = calendarDate(input.issuedOn, 'Reminder issue date'); const paymentDueDate = calendarDate(input.paymentDueDate, 'Payment due date')
  if (paymentDueDate <= issuedOn) throw new ReceivablesReminderError('Payment due date must be after the reminder issue date.')
  const requestHash = hash({ openItemId: input.openItemId, issuedOn: input.issuedOn, paymentDueDate: input.paymentDueDate })
  const run = () => prisma.$transaction(async transaction => {
    const existing = await transaction.receivablesReminder.findUnique({ where: { ownerId_requestKey: { ownerId, requestKey: key } }, include: { cancellation: true } })
    if (existing) { if (existing.requestHash !== requestHash) throw new ReceivablesReminderError('The reminder request key was already used with different facts.'); return existing }
    const openItem = await transaction.openItem.findFirst({ where: { ownerId, id: input.openItemId }, include: { commercialDocument: { include: { businessPartner: true } }, receivablesReminders: { select: { level: true } } } })
    if (!openItem) throw new ReceivablesReminderError('The open item does not belong to this tenant.')
    const document = openItem.commercialDocument
    const remainingAmountCents = assertReminderEligible({ tenantId: ownerId, openItemTenantId: openItem.ownerId, direction: document.direction, kind: document.kind, documentStatus: document.status, status: openItem.status, dueDate: document.dueDate.toISOString().slice(0, 10), issuedOn: input.issuedOn, originalAmountCents: openItem.originalAmountCents, allocatedAmountCents: openItem.allocatedAmountCents })
    const level = nextReminderLevel(openItem.receivablesReminders.map(reminder => reminder.level))
    const partner = { name: document.businessPartner.name, street: document.businessPartner.street, houseNumber: document.businessPartner.houseNumber, postalCode: document.businessPartner.postalCode, city: document.businessPartner.city, countryCode: document.businessPartner.countryCode, email: document.businessPartner.email }
    const profileVersion = await transaction.companyProfileVersion.findFirst({ where: { ownerId, effectiveFrom: { lte: issuedOn } }, orderBy: { effectiveFrom: 'desc' } })
    let issuer: Record<string, unknown> = { companyName: ownerId }
    try { if (profileVersion) issuer = JSON.parse(profileVersion.payload) as Record<string, unknown> } catch { /* preserve a printable tenant identifier */ }
    const invoiceNumber = document.documentNumber || document.id
    const printableHtml = renderReminderHtml({ level, issuedOn: input.issuedOn, paymentDueDate: input.paymentDueDate, originalDueDate: document.dueDate.toISOString().slice(0, 10), remainingAmountCents, currency: openItem.currency, invoiceNumber, partnerName: partner.name, issuerName: typeof issuer.companyName === 'string' ? issuer.companyName : ownerId })
    const created = await transaction.receivablesReminder.create({ data: { id: randomUUID(), ownerId, openItemId: openItem.id, level, requestKey: key, requestHash, issuedOn, paymentDueDate, originalDueDate: document.dueDate, remainingAmountCents, currency: openItem.currency, invoiceNumber, partnerSnapshot: JSON.stringify(partner), issuerSnapshot: JSON.stringify(issuer), printableHtml, createdBy: actorId }, include: { cancellation: true } })
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'RECEIVABLES_REMINDER_ISSUED', reason: input.reason, objectType: 'ReceivablesReminder', objectId: created.id, after: created })
    return created
  })
  try { return await run() } catch (error) {
    if (!isUniqueConflict(error)) throw error
    const winner = await prisma.receivablesReminder.findUnique({ where: { ownerId_requestKey: { ownerId, requestKey: key } }, include: { cancellation: true } })
    if (winner) { if (winner.requestHash !== requestHash) throw new ReceivablesReminderError('The reminder request key was already used with different facts.'); return winner }
    throw new ReceivablesReminderError('A reminder was issued concurrently. Reload the history and retry with a new request key.')
  }
}

export async function cancelReceivablesReminder(ownerId: string, actorId: string, reminderId: string, durableRequestKey: string, input: { cancelledOn: string; reason: string }) {
  required(ownerId, 'ownerId'); required(actorId, 'actorId'); required(input.reason, 'Cancellation reason'); const key = requestKey(durableRequestKey); const cancelledOn = calendarDate(input.cancelledOn, 'Cancellation date')
  const requestHash = hash({ reminderId, cancelledOn: input.cancelledOn, reason: input.reason.trim() })
  const run = () => prisma.$transaction(async transaction => {
    const existing = await transaction.receivablesReminderCancellation.findUnique({ where: { ownerId_requestKey: { ownerId, requestKey: key } } })
    if (existing) { if (existing.requestHash !== requestHash) throw new ReceivablesReminderError('The cancellation request key was already used with different facts.'); return existing }
    const reminder = await transaction.receivablesReminder.findFirst({ where: { ownerId, id: reminderId }, include: { cancellation: true } })
    if (!reminder) throw new ReceivablesReminderError('The reminder does not belong to this tenant.')
    if (reminder.cancellation) throw new ReceivablesReminderError('The reminder is already cancelled; its history remains immutable.')
    if (cancelledOn < reminder.issuedOn) throw new ReceivablesReminderError('Cancellation date cannot precede the reminder issue date.')
    const created = await transaction.receivablesReminderCancellation.create({ data: { id: randomUUID(), ownerId, reminderId, requestKey: key, requestHash, cancelledOn, reason: input.reason.trim(), createdBy: actorId } })
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'RECEIVABLES_REMINDER_CANCELLED', reason: input.reason, objectType: 'ReceivablesReminderCancellation', objectId: created.id, after: created })
    return created
  })
  try { return await run() } catch (error) {
    if (!isUniqueConflict(error)) throw error
    const winner = await prisma.receivablesReminderCancellation.findUnique({ where: { ownerId_requestKey: { ownerId, requestKey: key } } })
    if (winner) { if (winner.requestHash !== requestHash) throw new ReceivablesReminderError('The cancellation request key was already used with different facts.'); return winner }
    throw new ReceivablesReminderError('The reminder was cancelled concurrently. Reload its immutable history before continuing.')
  }
}

function safeAttachmentFileName(invoiceNumber: string, level: number) {
  const safeInvoice = invoiceNumber.normalize('NFKC').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 80) || 'Rechnung'
  return `Zahlungserinnerung-${safeInvoice}-${level}.html`
}

export async function deliverReceivablesReminder(ownerId: string, actorId: string, reminderId: string, durableRequestKey: string, input: DeliverReminderInput, gateway: ReminderEmailGateway = configuredReminderEmailGateway()) {
  required(ownerId, 'ownerId'); required(actorId, 'actorId'); const approvalReason = required(input.reason, 'Delivery approval reason').normalize('NFKC')
  if (approvalReason.length > 500 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(approvalReason)) throw new ReceivablesReminderError('Delivery approval reason must be safe text of at most 500 characters.')
  const key = requestKey(durableRequestKey); const recipient = normalizeReminderRecipient(input.recipient)
  const requestHash = hash({ reminderId, recipient, approvalReason })
  const createAttempt = () => prisma.$transaction(async transaction => {
    const existing = await transaction.receivablesReminderDeliveryAttempt.findUnique({ where: { ownerId_requestKey: { ownerId, requestKey: key } }, include: { result: true, reminder: true } })
    if (existing) { if (existing.requestHash !== requestHash) throw new ReceivablesReminderError('The delivery request key was already used with different facts.'); return existing }
    const reminder = await transaction.receivablesReminder.findFirst({ where: { ownerId, id: reminderId }, include: { cancellation: true } })
    if (!reminder) throw new ReceivablesReminderError('The reminder does not belong to this tenant.')
    if (reminder.cancellation) throw new ReceivablesReminderError('A cancelled reminder cannot be delivered.')
    let issuerName = ownerId
    try { const issuer = JSON.parse(reminder.issuerSnapshot) as { companyName?: unknown }; if (typeof issuer.companyName === 'string' && issuer.companyName.trim()) issuerName = issuer.companyName.trim() } catch { /* retain immutable tenant fallback */ }
    const content = renderReminderDeliveryContent({ invoiceNumber: reminder.invoiceNumber, level: reminder.level, issuerName })
    const attachment = Buffer.from(reminder.printableHtml, 'utf8')
    if (attachment.byteLength > 500_000) throw new ReceivablesReminderError('The immutable reminder attachment exceeds the safe delivery limit.')
    const created = await transaction.receivablesReminderDeliveryAttempt.create({ data: { id: randomUUID(), ownerId, reminderId, requestKey: key, requestHash, recipient, subject: content.subject, contentHash: hash({ text: content.textBody, html: content.htmlBody }), attachmentFileName: safeAttachmentFileName(reminder.invoiceNumber, reminder.level), attachmentHash: createHash('sha256').update(attachment).digest('hex'), requestedBy: actorId }, include: { result: true, reminder: true } })
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'RECEIVABLES_REMINDER_DELIVERY_REQUESTED', reason: approvalReason, objectType: 'ReceivablesReminderDeliveryAttempt', objectId: created.id, after: { ...created, reminder: undefined } })
    return created
  })
  let attempt
  try { attempt = await createAttempt() } catch (error) {
    if (!isUniqueConflict(error)) throw error
    attempt = await prisma.receivablesReminderDeliveryAttempt.findUnique({ where: { ownerId_requestKey: { ownerId, requestKey: key } }, include: { result: true, reminder: true } })
    if (!attempt) throw new ReceivablesReminderError('The reminder delivery was requested concurrently. Reload before retrying.')
    if (attempt.requestHash !== requestHash) throw new ReceivablesReminderError('The delivery request key was already used with different facts.')
  }
  if (attempt.result) return attempt
  const cancellation = await prisma.receivablesReminderCancellation.findUnique({ where: { ownerId_reminderId: { ownerId, reminderId } } })
  if (cancellation) throw new ReceivablesReminderError('A cancelled reminder cannot be delivered.')
  let issuerName = ownerId
  try { const issuer = JSON.parse(attempt.reminder.issuerSnapshot) as { companyName?: unknown }; if (typeof issuer.companyName === 'string' && issuer.companyName.trim()) issuerName = issuer.companyName.trim() } catch { /* retain immutable tenant fallback */ }
  const content = renderReminderDeliveryContent({ invoiceNumber: attempt.reminder.invoiceNumber, level: attempt.reminder.level, issuerName })
  const attachmentBytes = Buffer.from(attempt.reminder.printableHtml, 'utf8')
  const gatewayResult = await gateway.send({ idempotencyKey: attempt.id, recipient: attempt.recipient, subject: content.subject, textBody: content.textBody, htmlBody: content.htmlBody, attachment: { fileName: attempt.attachmentFileName, contentType: 'text/html; charset=utf-8', contentBase64: attachmentBytes.toString('base64'), sha256: attempt.attachmentHash } })
  const persistResult = () => prisma.$transaction(async transaction => {
    const existing = await transaction.receivablesReminderDeliveryResult.findUnique({ where: { ownerId_attemptId: { ownerId, attemptId: attempt.id } } })
    if (existing) return existing
    const result = await transaction.receivablesReminderDeliveryResult.create({ data: { id: randomUUID(), ownerId, attemptId: attempt.id, status: gatewayResult.status, providerMessageId: gatewayResult.status === 'SENT' ? gatewayResult.providerMessageId : null, failureCode: gatewayResult.status === 'FAILED' ? gatewayResult.failureCode : null, failureMessage: gatewayResult.status === 'FAILED' ? gatewayResult.failureMessage : null } })
    await appendAuditEvent(transaction, { ownerId, actorId, action: gatewayResult.status === 'SENT' ? 'RECEIVABLES_REMINDER_DELIVERED' : 'RECEIVABLES_REMINDER_DELIVERY_FAILED', reason: approvalReason, objectType: 'ReceivablesReminderDeliveryResult', objectId: result.id, after: result })
    return result
  })
  let result
  try { result = await persistResult() } catch (error) {
    if (!isUniqueConflict(error)) throw error
    result = await prisma.receivablesReminderDeliveryResult.findUnique({ where: { ownerId_attemptId: { ownerId, attemptId: attempt.id } } })
    if (!result) throw new ReceivablesReminderError('The reminder provider result could not be recorded safely.')
  }
  return { ...attempt, result }
}

export function listReceivablesReminders(ownerId: string) { return prisma.receivablesReminder.findMany({ where: { ownerId }, include: { cancellation: true, deliveryAttempts: { include: { result: true }, orderBy: { requestedAt: 'asc' } } }, orderBy: [{ issuedOn: 'desc' }, { level: 'desc' }] }) }
export function getPrintableReceivablesReminder(ownerId: string, id: string) { return prisma.receivablesReminder.findFirst({ where: { ownerId, id }, select: { printableHtml: true, invoiceNumber: true, level: true } }) }
