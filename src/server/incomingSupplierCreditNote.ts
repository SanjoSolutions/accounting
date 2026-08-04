import 'server-only'

import { createHash, randomUUID } from 'node:crypto'
import type { StructuredInvoiceData } from '@/core/eInvoice'
import { planIncomingSupplierCredit } from '@/core/incomingSupplierCreditNote'
import { calculateVat } from '@/core/vatEngine'
import { appendAuditEvent } from '@/server/compliance/auditPersistence'
import { commercialDocumentIdentity } from '@/server/commercialAccountingRepository'
import { prisma } from '@/server/persistence/client'
import { germanVatRuleBook, journalLineVatData, vatPostingCreateData } from '@/server/tax/vatPostingCalculation'

export class IncomingSupplierCreditNoteError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

const correctionInclude = { businessPartner: true, openItem: true, correctionNetting: true, postingJournalEntry: { include: { lines: { include: { account: true, vatPosting: true } }, documents: true } } } as const

export async function getIncomingSupplierCreditContext(ownerId: string, evidenceDocumentId: string) {
  const structured = await prisma.structuredInvoice.findFirst({ where: { ownerId, documentId: evidenceDocumentId, direction: 'INCOMING', kind: { in: ['credit-note', 'cancellation'] } } })
  if (!structured?.correctsId) throw new IncomingSupplierCreditNoteError('A linked incoming structured supplier credit note is required.', 404)
  const original = await prisma.structuredInvoice.findFirst({ where: { ownerId, id: structured.correctsId, direction: 'INCOMING', kind: 'invoice' }, include: { commercialDocument: { include: { businessPartner: true, openItem: true } } } })
  if (!original?.commercialDocument?.openItem || original.commercialDocument.status === 'DRAFT') throw new IncomingSupplierCreditNoteError('The exact referenced supplier invoice must be posted before its credit note.', 409)
  const existing = await prisma.commercialDocument.findUnique({ where: { ownerId_structuredInvoiceId: { ownerId, structuredInvoiceId: structured.id } }, include: correctionInclude })
  const data = JSON.parse(structured.data) as StructuredInvoiceData
  return { correction: existing, credit: { kind: data.kind, documentNumber: data.invoiceNumber, issueDate: data.issueDate, correctedInvoiceNumber: data.correctedInvoiceNumber, grossAmountCents: data.grossAmountCents, syntax: data.syntax }, original: { id: original.commercialDocument.id, documentNumber: original.commercialDocument.documentNumber, supplier: original.commercialDocument.businessPartner.name, remainingAmountCents: original.commercialDocument.openItem.originalAmountCents - original.commercialDocument.openItem.allocatedAmountCents, currency: original.commercialDocument.currency } }
}

export async function postIncomingSupplierCredit(ownerId: string, actorId: string, evidenceDocumentId: string, input: { effectiveDate: string; requestKey: string; reason: string }) {
  required(ownerId, 'Authenticated tenant'); required(actorId, 'Authenticated actor'); required(evidenceDocumentId, 'Credit-note evidence'); required(input?.reason, 'Posting reason')
  if (!/^[A-Za-z0-9._:-]{16,100}$/.test(input?.requestKey ?? '')) throw new IncomingSupplierCreditNoteError('Credit-note idempotency key must contain 16-100 safe characters.')
  const effectiveDate = parseDate(input?.effectiveDate, 'Adjustment-effective date')
  const run = () => prisma.$transaction(async transaction => {
    const structured = await transaction.structuredInvoice.findFirst({ where: { ownerId, documentId: evidenceDocumentId, direction: 'INCOMING', kind: { in: ['credit-note', 'cancellation'] } } })
    if (!structured?.correctsId) throw new IncomingSupplierCreditNoteError('A linked incoming structured supplier credit note is required.', 409)
    const existing = await transaction.commercialDocument.findUnique({ where: { ownerId_structuredInvoiceId: { ownerId, structuredInvoiceId: structured.id } }, include: correctionInclude })
    if (existing) {
      if (existing.correctionNetting?.effectiveDate.toISOString().slice(0, 10) !== input.effectiveDate) throw new IncomingSupplierCreditNoteError('This immutable supplier credit note was already posted with a different adjustment-effective date.', 409)
      return existing
    }
    const originalStructured = await transaction.structuredInvoice.findFirst({ where: { ownerId, id: structured.correctsId, direction: 'INCOMING', kind: 'invoice' }, include: { commercialDocument: { include: { businessPartner: true, openItem: true, correctedBy: { where: { status: 'POSTED' }, include: { structuredInvoice: true } }, postingJournalEntry: { include: { lines: { include: { account: true, vatPosting: true } } } } } } } })
    const original = originalStructured?.commercialDocument
    if (!original?.openItem || !original.postingJournalEntryId || original.direction !== 'PAYABLE' || original.kind !== 'INVOICE') throw new IncomingSupplierCreditNoteError('The exact tenant-owned referenced payable invoice must be posted and have an open-item ledger origin.', 409)
    const creditData = JSON.parse(structured.data) as StructuredInvoiceData
    const originalData = JSON.parse(originalStructured!.data) as StructuredInvoiceData
    if (structured.issuerKey !== originalStructured!.issuerKey) throw new IncomingSupplierCreditNoteError('The correction issuer does not match the immutable original supplier.', 409)
    const priorCredits = original.correctedBy.flatMap(item => item.structuredInvoice ? [JSON.parse(item.structuredInvoice.data) as StructuredInvoiceData] : [])
    const originalVat = original.postingJournalEntry!.lines.flatMap(line => line.vatPosting ? [line.vatPosting] : [])
    const originalAuthoritativeDates = [original.serviceDate, original.postingJournalEntry!.bookingDate, ...originalVat.map(posting => posting.taxPoint)].map(date => date.toISOString().slice(0, 10))
    let plan
    try { plan = planIncomingSupplierCredit({ credit: creditData, original: originalData, priorCredits, originalRemainingCents: original.openItem.originalAmountCents - original.openItem.allocatedAmountCents, effectiveDate: input.effectiveDate, originalAuthoritativeDates }) }
    catch (error) { throw new IncomingSupplierCreditNoteError(error instanceof Error ? error.message : 'Invalid supplier correction.', 409) }
    const periods = await transaction.fiscalYear.findMany({ where: { ownerId, status: 'OPEN', startsAt: { lte: effectiveDate }, endsAt: { gte: effectiveDate } } })
    if (periods.length !== 1) throw new IncomingSupplierCreditNoteError('Exactly one open fiscal year must cover the adjustment-effective date.', 409)
    await transaction.fiscalYear.updateMany({ where: { ownerId, id: periods[0].id, status: 'OPEN' }, data: { updatedAt: new Date() } })
    const profile = await transaction.ledgerProfile.findUnique({ where: { ownerId } })
    if (!profile || !['SKR03', 'SKR04'].includes(profile.chart)) throw new IncomingSupplierCreditNoteError('An active SKR03 or SKR04 ledger profile is required.', 409)
    const scale = 10 ** ((profile.accountLength ?? 4) - 4)
    const payableNumber = (profile.chart === 'SKR04' ? 3300 : 1600) * scale
    const requiredVatNumbers = plan.groups.map(group => (profile.chart === 'SKR04' ? group.rateBasisPoints === 700 ? 1401 : 1406 : group.rateBasisPoints === 700 ? 1571 : 1576) * scale)
    const controls = await transaction.ledgerAccount.findMany({ where: { ownerId, active: true, number: { in: [payableNumber, ...requiredVatNumbers] } } })
    const payable = controls.find(account => account.number === payableNumber && account.category === 'LIABILITY')
    if (!payable) throw new IncomingSupplierCreditNoteError('The active trade-payables control account is missing.', 409)
    const groups = plan.groups.map(group => {
      const originalPosting = originalVat.find(posting => posting.rateBasisPoints === group.rateBasisPoints && posting.ruleId === (group.rateBasisPoints === 700 ? 'DE_REDUCED' : 'DE_STANDARD'))
      const originalExpenseLine = original.postingJournalEntry!.lines.find(line => line.taxCode === originalPosting?.ruleId && line.account.category === 'EXPENSE')
      const inputVat = controls.find(account => account.number === requiredVatNumbers[plan.groups.indexOf(group)] && account.category === 'ASSET')
      if (!originalPosting || !originalExpenseLine || !inputVat || group.netAmountCents > originalPosting.netBaseCents) throw new IncomingSupplierCreditNoteError(`The original ${group.rateBasisPoints / 100}% expense and canonical input-VAT provenance is incomplete.`, 409)
      const detail = calculateVat({ ownerId, sourceId: `incoming-supplier-credit:${structured.id}:vat:${group.rateBasisPoints}`, amountCents: group.netAmountCents, mode: 'net', taxPoint: input.effectiveDate, ruleId: group.rateBasisPoints === 700 ? 'DE_REDUCED' : 'DE_STANDARD', direction: 'purchase' }, germanVatRuleBook)
      if (detail.taxCents !== group.taxAmountCents) throw new IncomingSupplierCreditNoteError('Supplier credit VAT differs from canonical German VAT calculation.', 409)
      return { group, originalPosting, expense: originalExpenseLine.account, inputVat, detail, expenseLineId: randomUUID() }
    })
    const last = await transaction.journalEntry.findFirst({ where: { fiscalYearId: periods[0].id }, orderBy: { sequenceNumber: 'desc' }, select: { sequenceNumber: true } })
    const key = createHash('sha256').update(`${ownerId}:${structured.id}`).digest('hex')
    const journal = await transaction.journalEntry.create({ data: { ownerId, fiscalYearId: periods[0].id, sequenceNumber: (last?.sequenceNumber ?? 0) + 1, bookingDate: effectiveDate, documentNumber: `EG-${creditData.invoiceNumber.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 25)}-${key.slice(0, 8).toUpperCase()}`, description: `Supplier ${creditData.kind === 'cancellation' ? 'cancellation' : 'credit note'} ${creditData.invoiceNumber} for ${original.documentNumber}`, source: 'INCOMING_SUPPLIER_CREDIT_NOTE', externalKey: `INCOMING-SUPPLIER-CREDIT:${key}`, ...(creditData.kind === 'cancellation' ? { reversalOfId: original.postingJournalEntryId } : {}), lines: { create: [{ accountId: payable.id, debitCents: plan.grossAmountCents, creditCents: 0 }, ...groups.flatMap(({ group, expense, inputVat, detail, expenseLineId, originalPosting }) => { const negative = negativeDetail(detail, `incoming-invoice:${original.evidenceDocumentId}:vat:${group.rateBasisPoints}`, originalPosting.taxPoint.toISOString().slice(0, 10)); return [{ id: expenseLineId, accountId: expense.id, debitCents: 0, creditCents: group.netAmountCents, ...journalLineVatData(negative) }, { accountId: inputVat.id, debitCents: 0, creditCents: group.taxAmountCents }] })] }, documents: { create: { documentId: evidenceDocumentId } } } })
    for (const group of groups) await transaction.vatPostingRecord.create({ data: vatPostingCreateData(ownerId, group.expenseLineId, negativeDetail(group.detail, `incoming-invoice:${original.evidenceDocumentId}:vat:${group.group.rateBasisPoints}`, group.originalPosting.taxPoint.toISOString().slice(0, 10)), evidenceDocumentId) })
    const identity = commercialDocumentIdentity('PAYABLE', original.businessPartner.vatId || original.businessPartner.taxId || original.businessPartner.name, creditData.invoiceNumber)
    const correction = await transaction.commercialDocument.create({ data: { ownerId, businessPartnerId: original.businessPartnerId, structuredInvoiceId: structured.id, evidenceDocumentId, postingJournalEntryId: journal.id, correctsId: original.id, direction: 'PAYABLE', kind: 'CREDIT_NOTE', status: 'POSTED', documentNumber: creditData.invoiceNumber, documentIdentityKey: identity, issueDate: new Date(`${creditData.issueDate}T00:00:00.000Z`), serviceDate: effectiveDate, dueDate: effectiveDate, description: creditData.lines.map(line => line.description).join('; '), currency: 'EUR', netAmountCents: plan.netAmountCents, taxAmountCents: plan.taxAmountCents, grossAmountCents: plan.grossAmountCents, payableAmountCents: plan.grossAmountCents, counterpartySnapshot: original.counterpartySnapshot, openItem: { create: { side: 'DEBIT', currency: 'EUR', originalAmountCents: plan.grossAmountCents } } }, include: { openItem: true } })
    const requestHash = createHash('sha256').update(JSON.stringify({ structuredInvoiceId: structured.id, originalOpenItemId: original.openItem.id, creditOpenItemId: correction.openItem!.id, amountCents: plan.nettingAmountCents, effectiveDate: input.effectiveDate })).digest('hex')
    await transaction.correctionNetting.create({ data: { ownerId, correctionDocumentId: correction.id, originalOpenItemId: original.openItem.id, creditOpenItemId: correction.openItem!.id, journalEntryId: journal.id, amountCents: plan.nettingAmountCents, requestKey: input.requestKey, requestHash, effectiveDate, createdBy: actorId } })
    // Production migrations derive these balances in a DB trigger. `prisma db
    // push` (used only by the real browser harness) cannot install SQLite
    // triggers, so apply the same transition iff the trigger demonstrably did
    // not run. The version check prevents a double application.
    const [derivedOriginal, derivedCredit] = await Promise.all([transaction.openItem.findUniqueOrThrow({ where: { id: original.openItem.id } }), transaction.openItem.findUniqueOrThrow({ where: { id: correction.openItem!.id } })])
    if (derivedOriginal.version === original.openItem.version && derivedCredit.version === correction.openItem!.version) {
      const originalAllocated = original.openItem.allocatedAmountCents + plan.nettingAmountCents
      await transaction.openItem.update({ where: { id: original.openItem.id }, data: { allocatedAmountCents: originalAllocated, status: status(originalAllocated, original.openItem.originalAmountCents), version: { increment: 1 } } })
      await transaction.openItem.update({ where: { id: correction.openItem!.id }, data: { allocatedAmountCents: plan.nettingAmountCents, status: status(plan.nettingAmountCents, correction.openItem!.originalAmountCents), version: { increment: 1 } } })
    }
    if (priorCredits.reduce((sum, prior) => sum + prior.grossAmountCents, 0) + plan.grossAmountCents === original.grossAmountCents) await transaction.commercialDocument.update({ where: { id: original.id }, data: { status: 'CORRECTED', version: { increment: 1 } } })
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'INCOMING_SUPPLIER_CREDIT_NOTE_POSTED', reason: input.reason, objectType: 'CommercialDocument', objectId: correction.id, after: { correctionDocumentId: correction.id, originalDocumentId: original.id, evidenceDocumentId, journalEntryId: journal.id, effectiveDate: input.effectiveDate, nettingAmountCents: plan.nettingAmountCents, unappliedSupplierCreditCents: plan.unappliedCreditCents, vatRates: plan.groups.map(group => group.rateBasisPoints) } })
    return transaction.commercialDocument.findUniqueOrThrow({ where: { id: correction.id }, include: correctionInclude })
  })
  try { return await run() }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
      const structured = await prisma.structuredInvoice.findFirst({ where: { ownerId, documentId: evidenceDocumentId, direction: 'INCOMING' } })
      const winner = structured ? await prisma.commercialDocument.findUnique({ where: { ownerId_structuredInvoiceId: { ownerId, structuredInvoiceId: structured.id } }, include: correctionInclude }) : null
      if (winner && winner.correctionNetting?.effectiveDate.toISOString().slice(0, 10) === input.effectiveDate) return winner
      if (winner) throw new IncomingSupplierCreditNoteError('The supplier credit note was posted concurrently with different facts.', 409)
      throw new IncomingSupplierCreditNoteError('The supplier credit note duplicates an existing immutable posting identity or idempotency key.', 409)
    }
    throw error
  }
}

function negativeDetail(detail: ReturnType<typeof calculateVat>, reversalOf: string, originalTaxPoint: string) { return { ...detail, amountCents: -detail.amountCents, netBaseCents: -detail.netBaseCents, taxCents: -detail.taxCents, deductibleTaxCents: -detail.deductibleTaxCents, grossCents: -detail.grossCents, outputTaxCents: -detail.outputTaxCents, inputTaxCents: -detail.inputTaxCents, reversalOf, originalTaxPoint } }
function status(allocated: number, original: number) { return allocated === 0 ? 'OPEN' : allocated === original ? 'SETTLED' : 'PARTIAL' }
function parseDate(value: string, label: string) { const date = new Date(`${value}T00:00:00.000Z`); if (typeof value !== 'string' || Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) throw new IncomingSupplierCreditNoteError(`${label} must be an ISO calendar date.`); return date }
function required(value: string, label: string) { if (!value?.trim()) throw new IncomingSupplierCreditNoteError(`${label} is required.`); return value.trim() }
