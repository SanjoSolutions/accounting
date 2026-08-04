import 'server-only'

import { createHash, randomUUID } from 'node:crypto'
import {
  addBusinessPartner,
  createCreditNoteDraft,
  createInvoiceDraft,
  emptyCommercialLedger,
  type BusinessPartner,
  type DocumentDirection,
  type DraftDocumentInput,
  type PartnerRole,
} from '@/core/commercialAccounting'
import type { StructuredInvoiceData } from '@/core/eInvoice'
import { calculateVat, type VatPostingDetail } from '@/core/vatEngine'
import { appendAuditEvent } from '@/server/compliance/auditPersistence'
import { prisma } from '@/server/persistence/client'
import { germanVatRuleBook, journalLineVatData, vatPostingCreateData } from '@/server/tax/vatPostingCalculation'

export class CommercialAccountingError extends Error {}

type OutgoingAccountingPreflightInput = Pick<StructuredInvoiceData, 'kind' | 'issueDate' | 'buyer' | 'lines' | 'netAmountCents' | 'taxAmountCents' | 'grossAmountCents' | 'currency' | 'prepaidAmountCents' | 'payableRoundingAmountCents' | 'payableAmountCents' | 'exemptionReason' | 'reverseCharge'>

/**
 * Checks every currently supported automatic posting prerequisite before an
 * invoice number is reserved or an immutable invoice artifact is stored.
 */
export async function preflightOutgoingStructuredInvoiceAccounting(ownerId: string, data: OutgoingAccountingPreflightInput) {
  required(ownerId, 'ownerId')
  if (data?.kind !== 'invoice') throw new CommercialAccountingError('Automatic outgoing-invoice posting requires an invoice.')
  const issueDate = new Date(`${data.issueDate}T00:00:00.000Z`)
  if (typeof data.issueDate !== 'string' || Number.isNaN(issueDate.valueOf()) || issueDate.toISOString().slice(0, 10) !== data.issueDate) throw new CommercialAccountingError('The outgoing invoice requires a real issue date.')
  const payableAmountCents = data.payableAmountCents ?? data.grossAmountCents - (data.prepaidAmountCents ?? 0) + (data.payableRoundingAmountCents ?? 0)
  if (!Number.isSafeInteger(payableAmountCents) || payableAmountCents < 0) throw new CommercialAccountingError('The structured invoice payable amount is invalid.')
  if (data.currency !== 'EUR' || data.buyer?.countryCode !== 'DE' || data.reverseCharge || data.exemptionReason || payableAmountCents !== data.grossAmountCents) throw new CommercialAccountingError('Automatic outgoing-invoice posting currently supports domestic EUR invoices without exemptions, reverse charge, prepayments or rounding.')
  const taxGroups = new Map<number, number>()
  for (const line of data.lines ?? []) {
    if (line.taxCategoryCode !== 'S' || ![700, 1900].includes(line.taxRateBasisPoints) || !Number.isSafeInteger(line.netAmountCents) || line.netAmountCents < 0) throw new CommercialAccountingError('Automatic outgoing-invoice posting supports only standard German 7% and 19% lines.')
    taxGroups.set(line.taxRateBasisPoints, (taxGroups.get(line.taxRateBasisPoints) ?? 0) + line.netAmountCents)
  }
  if (!taxGroups.size || [...taxGroups.values()].reduce((sum, amount) => sum + amount, 0) !== data.netAmountCents) throw new CommercialAccountingError('Outgoing invoice line bases do not reconcile to the invoice net amount.')
  const taxDetails = [...taxGroups].map(([rate, amountCents]) => calculateVat({ ownerId, sourceId: `outgoing-invoice-preflight:${rate}`, amountCents, mode: 'net', taxPoint: data.issueDate, ruleId: rate === 1900 ? 'DE_STANDARD' : 'DE_REDUCED', direction: 'sale' }, germanVatRuleBook))
  if (taxDetails.reduce((sum, detail) => sum + detail.taxCents, 0) !== data.taxAmountCents || data.netAmountCents + data.taxAmountCents !== data.grossAmountCents) throw new CommercialAccountingError('Outgoing invoice totals do not reconcile to the supported VAT groups.')
  const periods = await prisma.fiscalYear.findMany({ where: { ownerId, status: 'OPEN', startsAt: { lte: issueDate }, endsAt: { gte: issueDate } }, select: { id: true } })
  if (periods.length !== 1) throw new CommercialAccountingError('Exactly one open fiscal year must cover the outgoing invoice date.')
  const profile = await prisma.ledgerProfile.findUnique({ where: { ownerId } })
  if (!profile || !['SKR03', 'SKR04'].includes(profile.chart)) throw new CommercialAccountingError('An active SKR03 or SKR04 ledger profile is required for outgoing invoice posting.')
  const scale = 10 ** ((profile.accountLength ?? 4) - 4)
  const requiredAccounts = [
    { number: (profile.chart === 'SKR04' ? 1200 : 1400) * scale, category: 'ASSET' },
    ...taxDetails.flatMap(detail => {
      const reduced = detail.rateBasisPoints === 700
      return [
        { number: (profile.chart === 'SKR04' ? reduced ? 4300 : 4400 : reduced ? 8300 : 8400) * scale, category: 'REVENUE' },
        { number: (profile.chart === 'SKR04' ? reduced ? 3801 : 3806 : reduced ? 1771 : 1776) * scale, category: 'LIABILITY' },
      ]
    }),
  ]
  const accounts = await prisma.ledgerAccount.findMany({ where: { ownerId, active: true, number: { in: requiredAccounts.map(account => account.number) } }, select: { number: true, category: true } })
  const missing = requiredAccounts.find(required => !accounts.some(account => account.number === required.number && account.category === required.category))
  if (missing) throw new CommercialAccountingError(`The active ${missing.category.toLowerCase()} account ${missing.number} required for outgoing invoice posting is missing.`)
}

export async function preflightOutgoingStructuredCorrectionAccounting(ownerId: string, targetId: string, data: OutgoingAccountingPreflightInput) {
  required(ownerId, 'ownerId'); required(targetId, 'corrected invoice')
  if (!['credit-note', 'cancellation'].includes(data?.kind)) throw new CommercialAccountingError('Only a credit note or full cancellation is supported; replacement correction semantics are not supported.')
  const target = await prisma.structuredInvoice.findFirst({ where: { ownerId, id: targetId, direction: 'OUTGOING', kind: 'invoice' }, include: { commercialDocument: { include: { openItem: true, correctedBy: { where: { status: 'POSTED' } } } } } })
  if (!target?.commercialDocument?.openItem || target.commercialDocument.status === 'CORRECTED') throw new CommercialAccountingError('The corrected posted outgoing invoice does not belong to this tenant or is unavailable.')
  await preflightOutgoingStructuredInvoiceAccounting(ownerId, { ...data, kind: 'invoice' })
  const original = JSON.parse(target.data) as StructuredInvoiceData
  if (data.currency !== original.currency || data.buyer.countryCode !== 'DE' || JSON.stringify(data.buyer) !== JSON.stringify(original.buyer)) throw new CommercialAccountingError('The correction must retain the original domestic customer and EUR currency facts.')
  const alreadyCredited = target.commercialDocument.correctedBy.reduce((sum, document) => sum + document.grossAmountCents, 0)
  if (data.grossAmountCents <= 0 || alreadyCredited + data.grossAmountCents > original.grossAmountCents) throw new CommercialAccountingError('The correction exceeds the immutable original invoice amount.')
  const originalRates = new Map<number, number>(); for (const line of original.lines) originalRates.set(line.taxRateBasisPoints, (originalRates.get(line.taxRateBasisPoints) ?? 0) + line.netAmountCents)
  const correctionRates = new Map<number, number>(); for (const line of data.lines) correctionRates.set(line.taxRateBasisPoints, (correctionRates.get(line.taxRateBasisPoints) ?? 0) + line.netAmountCents)
  if ([...correctionRates].some(([rate, amount]) => amount > (originalRates.get(rate) ?? 0))) throw new CommercialAccountingError('Correction VAT-rate bases must be a supported subset of the original invoice.')
  if (data.kind === 'cancellation' && (alreadyCredited !== 0 || data.netAmountCents !== original.netAmountCents || data.taxAmountCents !== original.taxAmountCents || data.grossAmountCents !== original.grossAmountCents)) throw new CommercialAccountingError('A cancellation must fully reverse the untouched original invoice; use a partial credit note otherwise.')
}

export interface BusinessPartnerInput {
  partnerNumber: string
  role: PartnerRole
  name: string
  contactName?: string
  email?: string
  street?: string
  houseNumber?: string
  postalCode?: string
  city?: string
  countryCode?: string
  vatId?: string
  taxId?: string
  paymentTermDays?: number
}

export interface CommercialDraftInput extends Omit<DraftDocumentInput, 'id' | 'tenantId'> {
  kind?: 'INVOICE' | 'CREDIT_NOTE'
  referenceInvoiceId?: string
}

function required(value: string, field: string) {
  if (!value?.trim()) throw new CommercialAccountingError(`${field} is required.`)
  return value.trim()
}

function normalizedOptional(value?: string) { return value?.trim() || null }

export async function createBusinessPartner(ownerId: string, actorId: string, input: BusinessPartnerInput) {
  required(ownerId, 'ownerId'); required(actorId, 'actorId')
  const id = randomUUID()
  const partner: BusinessPartner = { id, tenantId: ownerId, name: required(input.name, 'name'), role: input.role }
  if (!['CUSTOMER', 'SUPPLIER', 'BOTH'].includes(input.role)) throw new CommercialAccountingError('role must be CUSTOMER, SUPPLIER or BOTH.')
  addBusinessPartner(emptyCommercialLedger(), partner)
  const partnerNumber = required(input.partnerNumber, 'partnerNumber')
  const countryCode = (input.countryCode ?? 'DE').trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(countryCode)) throw new CommercialAccountingError('countryCode must contain two ISO country letters.')
  const paymentTermDays = input.paymentTermDays ?? 14
  if (!Number.isInteger(paymentTermDays) || paymentTermDays < 0 || paymentTermDays > 3650) throw new CommercialAccountingError('paymentTermDays must be an integer between 0 and 3650.')
  return prisma.$transaction(async transaction => {
    const created = await transaction.businessPartner.create({ data: {
      id, ownerId, partnerNumber, role: input.role, name: partner.name,
      contactName: normalizedOptional(input.contactName), email: normalizedOptional(input.email),
      street: normalizedOptional(input.street), houseNumber: normalizedOptional(input.houseNumber),
      postalCode: normalizedOptional(input.postalCode), city: normalizedOptional(input.city), countryCode,
      vatId: normalizedOptional(input.vatId)?.toUpperCase() ?? null, taxId: normalizedOptional(input.taxId), paymentTermDays,
    } })
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'BUSINESS_PARTNER_CREATED', reason: 'Business partner master data created', objectType: 'BusinessPartner', objectId: created.id, after: created })
    return created
  })
}

export async function listBusinessPartners(ownerId: string) {
  return prisma.businessPartner.findMany({ where: { ownerId }, orderBy: [{ active: 'desc' }, { name: 'asc' }, { partnerNumber: 'asc' }] })
}

export async function recordPaymentSettlement(ownerId: string, actorId: string, input: { businessPartnerId: string; journalEntryId: string; direction: 'RECEIPT' | 'DISBURSEMENT'; currency: string; amountCents: number; occurredOn: string; reason: string }) {
  required(ownerId, 'ownerId'); required(actorId, 'actorId'); required(input.reason, 'reason')
  if (!['RECEIPT', 'DISBURSEMENT'].includes(input.direction)) throw new CommercialAccountingError('Payment direction must be RECEIPT or DISBURSEMENT.')
  if (!/^[A-Z]{3}$/.test(input.currency) || !Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new CommercialAccountingError('Payment requires an uppercase ISO currency and positive integer cents.')
  const occurredOn = new Date(`${input.occurredOn}T00:00:00.000Z`)
  if (Number.isNaN(occurredOn.valueOf()) || occurredOn.toISOString().slice(0, 10) !== input.occurredOn) throw new CommercialAccountingError('Payment date must be an ISO calendar date.')
  return prisma.$transaction(async transaction => {
    const existing = await transaction.paymentSettlement.findUnique({ where: { ownerId_journalEntryId: { ownerId, journalEntryId: input.journalEntryId } } })
    if (existing) {
      if (existing.businessPartnerId !== input.businessPartnerId || existing.direction !== input.direction || existing.currency !== input.currency || existing.amountCents !== input.amountCents || existing.occurredOn.toISOString().slice(0, 10) !== input.occurredOn) throw new CommercialAccountingError('The payment journal was already registered with different facts.')
      return existing
    }
    const partner = await transaction.businessPartner.findFirst({ where: { ownerId, id: input.businessPartnerId, active: true } })
    if (!partner) throw new CommercialAccountingError('The active payment business partner does not belong to this tenant.')
    if (partner.role !== 'BOTH' && partner.role !== (input.direction === 'RECEIPT' ? 'CUSTOMER' : 'SUPPLIER')) throw new CommercialAccountingError('The business partner role does not match the payment direction.')
    const journal = await transaction.journalEntry.findFirst({ where: { ownerId, id: input.journalEntryId, state: 'POSTED' }, include: { lines: true } })
    if (!journal) throw new CommercialAccountingError('The payment journal entry does not belong to this tenant or is not posted.')
    const debit = journal.lines.reduce((sum, line) => sum + line.debitCents, 0); const credit = journal.lines.reduce((sum, line) => sum + line.creditCents, 0)
    if (!Number.isSafeInteger(debit) || debit !== credit || debit !== input.amountCents) throw new CommercialAccountingError('The posted payment journal must balance exactly to the registered payment amount.')
    const created = await transaction.paymentSettlement.create({ data: { ownerId, businessPartnerId: partner.id, journalEntryId: journal.id, direction: input.direction, currency: input.currency, amountCents: input.amountCents, occurredOn, createdBy: actorId } })
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'PAYMENT_SETTLEMENT_RECORDED', reason: input.reason, objectType: 'PaymentSettlement', objectId: created.id, after: created })
    return created
  })
}

export async function createCommercialDocumentDraft(ownerId: string, actorId: string, input: CommercialDraftInput) {
  required(ownerId, 'ownerId'); required(actorId, 'actorId')
  if (!['RECEIVABLE', 'PAYABLE'].includes(input.direction)) throw new CommercialAccountingError('direction must be RECEIVABLE or PAYABLE.')
  if (input.kind !== undefined && !['INVOICE', 'CREDIT_NOTE'].includes(input.kind)) throw new CommercialAccountingError('kind must be INVOICE or CREDIT_NOTE.')
  const partner = await prisma.businessPartner.findFirst({ where: { ownerId, id: input.partnerId, active: true } })
  if (!partner) throw new CommercialAccountingError('The active business partner does not belong to this tenant.')
  const id = randomUUID()
  const domainPartner: BusinessPartner = { id: partner.id, tenantId: ownerId, name: partner.name, role: partner.role as PartnerRole }
  let ledger = addBusinessPartner(emptyCommercialLedger(), domainPartner)
  const draftInput: DraftDocumentInput = { ...input, id, tenantId: ownerId }
  if ((input.kind ?? 'INVOICE') === 'CREDIT_NOTE') {
    if (!input.referenceInvoiceId) throw new CommercialAccountingError('A credit note requires a referenced invoice.')
    const reference = await prisma.commercialDocument.findFirst({ where: { ownerId, id: input.referenceInvoiceId, status: { in: ['FINAL', 'POSTED', 'CORRECTED'] } } })
    if (!reference) throw new CommercialAccountingError('The referenced invoice does not belong to this tenant or is not final.')
    ledger = createInvoiceDraft(ledger, { id: reference.id, tenantId: ownerId, partnerId: reference.businessPartnerId, direction: reference.direction as DocumentDirection, currency: reference.currency, netMinor: reference.netAmountCents, taxMinor: reference.taxAmountCents, grossMinor: reference.grossAmountCents, serviceDate: reference.serviceDate.toISOString().slice(0, 10), dueDate: reference.dueDate.toISOString().slice(0, 10), description: 'Persisted reference' })
    ledger = { ...ledger, documents: ledger.documents.map(document => document.id === reference.id ? { ...document, status: 'ISSUED' as const, documentNumber: reference.documentNumber ?? 'REFERENCE', issuedAt: reference.issueDate?.toISOString().slice(0, 10) ?? reference.serviceDate.toISOString().slice(0, 10) } : document) }
    createCreditNoteDraft(ledger, { ...draftInput, referenceInvoiceId: reference.id })
  } else createInvoiceDraft(ledger, draftInput)
  return prisma.$transaction(async transaction => {
    const created = await transaction.commercialDocument.create({ data: {
      id, ownerId, businessPartnerId: input.partnerId, direction: input.direction, kind: input.kind ?? 'INVOICE', status: 'DRAFT', correctsId: input.referenceInvoiceId ?? null,
      serviceDate: new Date(`${input.serviceDate}T00:00:00.000Z`), dueDate: new Date(`${input.dueDate}T00:00:00.000Z`), description: input.description.trim(), currency: input.currency,
      netAmountCents: input.netMinor, taxAmountCents: input.taxMinor, grossAmountCents: input.grossMinor, payableAmountCents: input.grossMinor,
    } })
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'COMMERCIAL_DOCUMENT_DRAFTED', reason: 'Commercial document draft created', objectType: 'CommercialDocument', objectId: id, after: created })
    return created
  })
}

export async function registerOutgoingStructuredInvoice(ownerId: string, actorId: string, structuredInvoiceId: string) {
  required(ownerId, 'ownerId'); required(actorId, 'actorId'); required(structuredInvoiceId, 'structuredInvoiceId')
  const run = () => prisma.$transaction(async transaction => {
    const existing = await transaction.commercialDocument.findUnique({ where: { ownerId_structuredInvoiceId: { ownerId, structuredInvoiceId } }, include: { openItem: true, businessPartner: true } })
    if (existing) {
      if (!existing.postingJournalEntryId) throw new CommercialAccountingError('The registered outgoing invoice is missing its originating ledger posting.')
      return existing
    }
    const structured = await transaction.structuredInvoice.findFirst({ where: { ownerId, id: structuredInvoiceId, direction: 'OUTGOING', kind: 'invoice' } })
    if (!structured) throw new CommercialAccountingError('The outgoing structured invoice does not belong to this tenant or is not an invoice.')
    const data = JSON.parse(structured.data) as StructuredInvoiceData
    const buyer = data.buyer
    const partner = await transaction.businessPartner.findFirst({ where: { ownerId, ...(buyer.vatId ? { vatId: buyer.vatId } : { name: buyer.name, street: buyer.street, postalCode: buyer.postalCode, city: buyer.city, countryCode: buyer.countryCode }) } }) ?? await transaction.businessPartner.create({ data: {
      ownerId, partnerNumber: `K-${createHash('sha256').update(JSON.stringify([buyer.vatId ?? '', buyer.name, buyer.street, buyer.postalCode, buyer.city, buyer.countryCode])).digest('hex').slice(0, 10).toUpperCase()}`,
      role: 'CUSTOMER', name: buyer.name, street: buyer.street, postalCode: buyer.postalCode, city: buyer.city, countryCode: buyer.countryCode, vatId: buyer.vatId ?? null, taxId: buyer.taxId ?? null,
    } })
    const issueDate = new Date(`${data.issueDate}T00:00:00.000Z`); const serviceDate = new Date(`${data.supplyDate}T00:00:00.000Z`)
    const dueDate = new Date(Math.max(serviceDate.valueOf(), issueDate.valueOf() + partner.paymentTermDays * 86_400_000))
    const payableAmountCents = data.payableAmountCents ?? data.grossAmountCents - (data.prepaidAmountCents ?? 0) + (data.payableRoundingAmountCents ?? 0)
    if (!Number.isSafeInteger(payableAmountCents) || payableAmountCents < 0) throw new CommercialAccountingError('The structured invoice payable amount is invalid.')
    if (data.currency !== 'EUR' || data.buyer.countryCode !== 'DE' || data.reverseCharge || data.exemptionReason || payableAmountCents !== data.grossAmountCents) throw new CommercialAccountingError('Automatic outgoing-invoice posting currently supports domestic EUR invoices without exemptions, reverse charge, prepayments or rounding.')
    const taxGroups = new Map<number, number>()
    for (const line of data.lines) {
      if (line.taxCategoryCode !== 'S' || ![700, 1900].includes(line.taxRateBasisPoints) || !Number.isSafeInteger(line.netAmountCents) || line.netAmountCents < 0) throw new CommercialAccountingError('Automatic outgoing-invoice posting supports only standard German 7% and 19% lines.')
      taxGroups.set(line.taxRateBasisPoints, (taxGroups.get(line.taxRateBasisPoints) ?? 0) + line.netAmountCents)
    }
    if ([...taxGroups.values()].reduce((sum, amount) => sum + amount, 0) !== data.netAmountCents) throw new CommercialAccountingError('Outgoing invoice line bases do not reconcile to the invoice net amount.')
    const taxDetails = [...taxGroups].sort(([left], [right]) => left - right).map(([rate, amountCents]) => calculateVat({ ownerId, sourceId: `outgoing-invoice:${structured.id}:vat:${rate}`, amountCents, mode: 'net', taxPoint: data.issueDate, ruleId: rate === 1900 ? 'DE_STANDARD' : 'DE_REDUCED', direction: 'sale' }, germanVatRuleBook))
    if (taxDetails.reduce((sum, detail) => sum + detail.taxCents, 0) !== data.taxAmountCents) throw new CommercialAccountingError('Outgoing invoice tax groups do not reconcile to the invoice VAT amount.')
    const periods = await transaction.fiscalYear.findMany({ where: { ownerId, status: 'OPEN', startsAt: { lte: issueDate }, endsAt: { gte: issueDate } } })
    if (periods.length !== 1) throw new CommercialAccountingError('Exactly one open fiscal year must cover the outgoing invoice date.')
    await transaction.fiscalYear.updateMany({ where: { ownerId, id: periods[0].id, status: 'OPEN' }, data: { updatedAt: new Date() } })
    const profile = await transaction.ledgerProfile.findUnique({ where: { ownerId } })
    if (!profile || !['SKR03', 'SKR04'].includes(profile.chart)) throw new CommercialAccountingError('An active SKR03 or SKR04 ledger profile is required for outgoing invoice posting.')
    const scale = 10 ** ((profile.accountLength ?? 4) - 4)
    const receivableNumber = (profile.chart === 'SKR04' ? 1200 : 1400) * scale
    const accountNumbers = [receivableNumber, ...taxDetails.flatMap(detail => {
      const reduced = detail.rateBasisPoints === 700
      return [(profile.chart === 'SKR04' ? reduced ? 4300 : 4400 : reduced ? 8300 : 8400) * scale, (profile.chart === 'SKR04' ? reduced ? 3801 : 3806 : reduced ? 1771 : 1776) * scale]
    })]
    const accounts = await transaction.ledgerAccount.findMany({ where: { ownerId, active: true, number: { in: accountNumbers } } })
    const account = (number: number, category: string) => accounts.find(candidate => candidate.number === number && candidate.category === category)
    const receivable = account(receivableNumber, 'ASSET')
    if (!receivable) throw new CommercialAccountingError('The active trade-receivables control account is missing.')
    const postingGroups = taxDetails.map(detail => {
      const reduced = detail.rateBasisPoints === 700
      const revenueNumber = (profile.chart === 'SKR04' ? reduced ? 4300 : 4400 : reduced ? 8300 : 8400) * scale
      const outputVatNumber = (profile.chart === 'SKR04' ? reduced ? 3801 : 3806 : reduced ? 1771 : 1776) * scale
      const revenue = account(revenueNumber, 'REVENUE'); const outputVat = account(outputVatNumber, 'LIABILITY')
      if (!revenue || !outputVat) throw new CommercialAccountingError(`The active ${detail.rateBasisPoints / 100}% revenue and output-VAT accounts are missing.`)
      return { detail, revenue, outputVat, revenueLineId: randomUUID() }
    })
    const last = await transaction.journalEntry.findFirst({ where: { fiscalYearId: periods[0].id }, orderBy: { sequenceNumber: 'desc' }, select: { sequenceNumber: true } })
    const journalKey = createHash('sha256').update(`${ownerId}:${structured.id}`).digest('hex')
    const journal = await transaction.journalEntry.create({ data: {
      ownerId, fiscalYearId: periods[0].id, sequenceNumber: (last?.sequenceNumber ?? 0) + 1, bookingDate: issueDate,
      documentNumber: `AR-${data.invoiceNumber.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 25)}-${journalKey.slice(0, 10).toUpperCase()}`, description: `Outgoing invoice ${data.invoiceNumber}: ${buyer.name}`, source: 'OUTGOING_INVOICE', externalKey: `OUTGOING-INVOICE:${journalKey}`,
      lines: { create: [
        { accountId: receivable.id, debitCents: data.grossAmountCents, creditCents: 0 },
        ...postingGroups.flatMap(({ detail, revenue, outputVat, revenueLineId }) => [
          { id: revenueLineId, accountId: revenue.id, debitCents: 0, creditCents: detail.netBaseCents, ...journalLineVatData(detail) },
          { accountId: outputVat.id, debitCents: 0, creditCents: detail.taxCents },
        ]),
      ] }, documents: { create: { documentId: structured.documentId } },
    } })
    for (const group of postingGroups) await transaction.vatPostingRecord.create({ data: vatPostingCreateData(ownerId, group.revenueLineId, group.detail as VatPostingDetail, structured.documentId) })
    const commercial = await transaction.commercialDocument.create({ data: {
      ownerId, businessPartnerId: partner.id, structuredInvoiceId: structured.id, evidenceDocumentId: structured.documentId, postingJournalEntryId: journal.id,
      direction: 'RECEIVABLE', kind: 'INVOICE', status: 'POSTED', documentNumber: data.invoiceNumber,
      documentIdentityKey: commercialDocumentIdentity('RECEIVABLE', ownerId, data.invoiceNumber), issueDate, serviceDate, dueDate,
      description: data.lines.map(line => line.description).join('; '), currency: data.currency, netAmountCents: data.netAmountCents, taxAmountCents: data.taxAmountCents, grossAmountCents: data.grossAmountCents, payableAmountCents,
      counterpartySnapshot: JSON.stringify(buyer), ...(payableAmountCents > 0 ? { openItem: { create: { side: 'DEBIT', currency: data.currency, originalAmountCents: payableAmountCents } } } : {}),
    }, include: { openItem: true, businessPartner: true } })
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'STRUCTURED_INVOICE_REGISTERED', reason: 'Outgoing structured invoice registered as a commercial receivable', objectType: 'CommercialDocument', objectId: commercial.id, after: commercial })
    return commercial
  })
  try { return await run() }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
      const winner = await prisma.commercialDocument.findUnique({ where: { ownerId_structuredInvoiceId: { ownerId, structuredInvoiceId } }, include: { openItem: true, businessPartner: true } })
      if (winner) return winner
      return run()
    }
    throw error
  }
}

export async function registerOutgoingStructuredCorrection(ownerId: string, actorId: string, structuredInvoiceId: string, requestKey: string) {
  required(ownerId, 'ownerId'); required(actorId, 'actorId'); required(structuredInvoiceId, 'structuredInvoiceId'); required(requestKey, 'requestKey')
  const run = () => prisma.$transaction(async transaction => {
    const existing = await transaction.commercialDocument.findUnique({ where: { ownerId_structuredInvoiceId: { ownerId, structuredInvoiceId } }, include: { openItem: true, correctionNetting: true } })
    if (existing) return existing
    const structured = await transaction.structuredInvoice.findFirst({ where: { ownerId, id: structuredInvoiceId, direction: 'OUTGOING', kind: { in: ['credit-note', 'cancellation'] } } })
    if (!structured?.correctsId) throw new CommercialAccountingError('The outgoing correction does not belong to this tenant or lacks immutable correction lineage.')
    const data = JSON.parse(structured.data) as StructuredInvoiceData
    const originalStructured = await transaction.structuredInvoice.findFirst({ where: { ownerId, id: structured.correctsId, direction: 'OUTGOING', kind: 'invoice' }, include: { commercialDocument: { include: { openItem: true, correctedBy: { where: { status: 'POSTED' } } } } } })
    const original = originalStructured?.commercialDocument
    if (!original?.openItem || !original.postingJournalEntryId) throw new CommercialAccountingError('The corrected posted outgoing invoice does not belong to this tenant or has no debit open item.')
    const originalData = JSON.parse(originalStructured!.data) as StructuredInvoiceData
    if (!['credit-note', 'cancellation'].includes(data.kind) || data.currency !== 'EUR' || data.buyer.countryCode !== 'DE' || data.reverseCharge || data.exemptionReason || JSON.stringify(data.buyer) !== JSON.stringify(originalData.buyer)) throw new CommercialAccountingError('Only domestic EUR 7%/19% credit notes and cancellations for the original customer are supported.')
    const credited = original.correctedBy.reduce((sum, document) => sum + document.grossAmountCents, 0)
    if (data.grossAmountCents <= 0 || credited + data.grossAmountCents > original.grossAmountCents) throw new CommercialAccountingError('The correction exceeds the immutable original invoice amount.')
    if (data.kind === 'cancellation' && (credited !== 0 || data.netAmountCents !== original.netAmountCents || data.taxAmountCents !== original.taxAmountCents || data.grossAmountCents !== original.grossAmountCents)) throw new CommercialAccountingError('A cancellation must fully reverse the untouched original invoice.')
    const issueDate = new Date(`${data.issueDate}T00:00:00.000Z`); const serviceDate = new Date(`${data.supplyDate}T00:00:00.000Z`)
    const taxGroups = new Map<number, number>()
    for (const line of data.lines) { if (line.taxCategoryCode !== 'S' || ![700, 1900].includes(line.taxRateBasisPoints) || !Number.isSafeInteger(line.netAmountCents) || line.netAmountCents <= 0) throw new CommercialAccountingError('Correction lines must use positive standard German 7% or 19% bases.'); taxGroups.set(line.taxRateBasisPoints, (taxGroups.get(line.taxRateBasisPoints) ?? 0) + line.netAmountCents) }
    const details = [...taxGroups].sort(([a], [b]) => a - b).map(([rate, amountCents]) => calculateVat({ ownerId, sourceId: `outgoing-correction:${structured.id}:vat:${rate}`, amountCents, mode: 'net', taxPoint: data.issueDate, ruleId: rate === 1900 ? 'DE_STANDARD' : 'DE_REDUCED', direction: 'sale' }, germanVatRuleBook))
    if (details.reduce((sum, detail) => sum + detail.netBaseCents, 0) !== data.netAmountCents || details.reduce((sum, detail) => sum + detail.taxCents, 0) !== data.taxAmountCents || data.netAmountCents + data.taxAmountCents !== data.grossAmountCents) throw new CommercialAccountingError('Correction totals do not reconcile to canonical VAT groups.')
    const periods = await transaction.fiscalYear.findMany({ where: { ownerId, status: 'OPEN', startsAt: { lte: issueDate }, endsAt: { gte: issueDate } } }); if (periods.length !== 1) throw new CommercialAccountingError('Exactly one open fiscal year must cover the correction date.')
    await transaction.fiscalYear.updateMany({ where: { ownerId, id: periods[0].id, status: 'OPEN' }, data: { updatedAt: new Date() } })
    const profile = await transaction.ledgerProfile.findUnique({ where: { ownerId } }); if (!profile || !['SKR03', 'SKR04'].includes(profile.chart)) throw new CommercialAccountingError('An active SKR03 or SKR04 ledger profile is required.')
    const scale = 10 ** ((profile.accountLength ?? 4) - 4); const receivableNumber = (profile.chart === 'SKR04' ? 1200 : 1400) * scale
    const accountNumbers = [receivableNumber, ...details.flatMap(detail => { const reduced = detail.rateBasisPoints === 700; return [(profile.chart === 'SKR04' ? reduced ? 4300 : 4400 : reduced ? 8300 : 8400) * scale, (profile.chart === 'SKR04' ? reduced ? 3801 : 3806 : reduced ? 1771 : 1776) * scale] })]
    const accounts = await transaction.ledgerAccount.findMany({ where: { ownerId, active: true, number: { in: accountNumbers } } }); const account = (number: number, category: string) => accounts.find(candidate => candidate.number === number && candidate.category === category)
    const receivable = account(receivableNumber, 'ASSET'); if (!receivable) throw new CommercialAccountingError('The active trade-receivables control account is missing.')
    const groups = details.map(detail => { const reduced = detail.rateBasisPoints === 700; const revenue = account((profile.chart === 'SKR04' ? reduced ? 4300 : 4400 : reduced ? 8300 : 8400) * scale, 'REVENUE'); const outputVat = account((profile.chart === 'SKR04' ? reduced ? 3801 : 3806 : reduced ? 1771 : 1776) * scale, 'LIABILITY'); if (!revenue || !outputVat) throw new CommercialAccountingError(`The active ${detail.rateBasisPoints / 100}% revenue and output-VAT accounts are missing.`); return { detail, revenue, outputVat, lineId: randomUUID() } })
    const last = await transaction.journalEntry.findFirst({ where: { fiscalYearId: periods[0].id }, orderBy: { sequenceNumber: 'desc' }, select: { sequenceNumber: true } }); const key = createHash('sha256').update(`${ownerId}:${structured.id}`).digest('hex')
    const journal = await transaction.journalEntry.create({ data: { ownerId, fiscalYearId: periods[0].id, sequenceNumber: (last?.sequenceNumber ?? 0) + 1, bookingDate: issueDate, documentNumber: `CN-${data.invoiceNumber.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 25)}-${key.slice(0, 8).toUpperCase()}`, description: `${data.kind === 'cancellation' ? 'Cancellation' : 'Credit note'} ${data.invoiceNumber} for ${original.documentNumber}`, source: 'OUTGOING_CREDIT_NOTE', externalKey: `OUTGOING-CORRECTION:${key}`, ...(data.kind === 'cancellation' ? { reversalOfId: original.postingJournalEntryId } : {}), lines: { create: [...groups.flatMap(({ detail, revenue, outputVat, lineId }) => { const negative = { ...detail, amountCents: -detail.amountCents, netBaseCents: -detail.netBaseCents, taxCents: -detail.taxCents, deductibleTaxCents: -detail.deductibleTaxCents, grossCents: -detail.grossCents, outputTaxCents: -detail.outputTaxCents, inputTaxCents: -detail.inputTaxCents, reversalOf: `outgoing-invoice:${originalStructured!.id}:vat:${detail.rateBasisPoints}`, originalTaxPoint: originalData.issueDate }; return [{ id: lineId, accountId: revenue.id, debitCents: detail.netBaseCents, creditCents: 0, ...journalLineVatData(negative) }, { accountId: outputVat.id, debitCents: detail.taxCents, creditCents: 0 }] }), { accountId: receivable.id, debitCents: 0, creditCents: data.grossAmountCents }] }, documents: { create: { documentId: structured.documentId } } } })
    for (const { detail, lineId } of groups) { const negative = { ...detail, amountCents: -detail.amountCents, netBaseCents: -detail.netBaseCents, taxCents: -detail.taxCents, deductibleTaxCents: -detail.deductibleTaxCents, grossCents: -detail.grossCents, outputTaxCents: -detail.outputTaxCents, inputTaxCents: -detail.inputTaxCents, reversalOf: `outgoing-invoice:${originalStructured!.id}:vat:${detail.rateBasisPoints}`, originalTaxPoint: originalData.issueDate }; await transaction.vatPostingRecord.create({ data: vatPostingCreateData(ownerId, lineId, negative, structured.documentId) }) }
    const correction = await transaction.commercialDocument.create({ data: { ownerId, businessPartnerId: original.businessPartnerId, structuredInvoiceId: structured.id, evidenceDocumentId: structured.documentId, postingJournalEntryId: journal.id, correctsId: original.id, direction: 'RECEIVABLE', kind: 'CREDIT_NOTE', status: 'POSTED', documentNumber: data.invoiceNumber, documentIdentityKey: commercialDocumentIdentity('RECEIVABLE', ownerId, data.invoiceNumber), issueDate, serviceDate, dueDate: issueDate, description: data.lines.map(line => line.description).join('; '), currency: 'EUR', netAmountCents: data.netAmountCents, taxAmountCents: data.taxAmountCents, grossAmountCents: data.grossAmountCents, payableAmountCents: data.grossAmountCents, counterpartySnapshot: original.counterpartySnapshot, openItem: { create: { side: 'CREDIT', currency: 'EUR', originalAmountCents: data.grossAmountCents } } }, include: { openItem: true } })
    const remaining = original.openItem.originalAmountCents - original.openItem.allocatedAmountCents; const netAmount = Math.min(remaining, correction.openItem!.originalAmountCents); const requestHash = createHash('sha256').update(JSON.stringify({ structuredInvoiceId, originalOpenItemId: original.openItem.id, creditOpenItemId: correction.openItem!.id, netAmount })).digest('hex')
    await transaction.correctionNetting.create({ data: { ownerId, correctionDocumentId: correction.id, originalOpenItemId: original.openItem.id, creditOpenItemId: correction.openItem!.id, journalEntryId: journal.id, amountCents: netAmount, requestKey, requestHash, effectiveDate: issueDate, createdBy: actorId } })
    const [derivedOriginal, derivedCredit] = await Promise.all([transaction.openItem.findUniqueOrThrow({ where: { id: original.openItem.id } }), transaction.openItem.findUniqueOrThrow({ where: { id: correction.openItem!.id } })])
    if (derivedOriginal.version === original.openItem.version && derivedCredit.version === correction.openItem!.version) {
      const originalAllocated = original.openItem.allocatedAmountCents + netAmount; const creditAllocated = netAmount
      await transaction.openItem.update({ where: { id: original.openItem.id }, data: { allocatedAmountCents: originalAllocated, status: originalAllocated === original.openItem.originalAmountCents ? 'SETTLED' : originalAllocated === 0 ? 'OPEN' : 'PARTIAL', version: { increment: 1 } } })
      await transaction.openItem.update({ where: { id: correction.openItem!.id }, data: { allocatedAmountCents: creditAllocated, status: creditAllocated === correction.openItem!.originalAmountCents ? 'SETTLED' : creditAllocated === 0 ? 'OPEN' : 'PARTIAL', version: { increment: 1 } } })
    }
    if (credited + data.grossAmountCents === original.grossAmountCents) await transaction.commercialDocument.update({ where: { id: original.id }, data: { status: 'CORRECTED', version: { increment: 1 } } })
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'OUTGOING_CREDIT_NOTE_POSTED', reason: 'Immutable outgoing correction issued and netted', objectType: 'CommercialDocument', objectId: correction.id, after: { correction, originalDocumentId: original.id, netAmountCents: netAmount, customerCreditBalanceCents: data.grossAmountCents - netAmount } })
    return transaction.commercialDocument.findUniqueOrThrow({ where: { id: correction.id }, include: { openItem: true, correctionNetting: true } })
  })
  try { return await run() } catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') { const winner = await prisma.commercialDocument.findUnique({ where: { ownerId_structuredInvoiceId: { ownerId, structuredInvoiceId } }, include: { openItem: true, correctionNetting: true } }); if (winner) return winner } throw error }
}

export async function reconcilePendingOutgoingInvoiceAccounting(ownerId: string, actorId: string) {
  required(ownerId, 'ownerId'); required(actorId, 'actorId')
  const issuedRequests = await prisma.invoiceIssuanceRequest.findMany({
    where: { ownerId, status: 'ISSUED', structuredInvoiceId: { not: null } },
    select: { structuredInvoiceId: true },
    orderBy: { createdAt: 'asc' },
  })
  const issuedIds = issuedRequests.flatMap(request => request.structuredInvoiceId ? [request.structuredInvoiceId] : [])
  if (!issuedIds.length) return []
  const pending = await prisma.structuredInvoice.findMany({
    where: { ownerId, id: { in: issuedIds }, direction: 'OUTGOING', kind: 'invoice', commercialDocument: null },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  })
  const registered = []
  for (const invoice of pending) registered.push(await registerOutgoingStructuredInvoice(ownerId, actorId, invoice.id))
  return registered
}

export function commercialDocumentIdentity(direction: DocumentDirection, issuerIdentity: string, documentNumber: string) {
  const normalized = [direction, required(issuerIdentity, 'issuerIdentity').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleUpperCase('de-DE'), required(documentNumber, 'documentNumber').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleUpperCase('de-DE')]
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

export async function finalizeCommercialDocument(ownerId: string, actorId: string, input: { draftId: string; documentNumber: string; issueDate: string; issuerIdentity: string; evidenceDocumentId: string; postingJournalEntryId: string; structuredInvoiceId?: string; reason: string }) {
  required(ownerId, 'ownerId'); required(actorId, 'actorId'); required(input.reason, 'reason')
  return prisma.$transaction(async transaction => {
    const draft = await transaction.commercialDocument.findFirst({ where: { ownerId, id: input.draftId, status: 'DRAFT' }, include: { businessPartner: true } })
    if (!draft) throw new CommercialAccountingError('The tenant commercial document draft does not exist or is already final.')
    const evidence = await transaction.documentRecord.findFirst({ where: { ownerId, id: input.evidenceDocumentId } })
    if (!evidence) throw new CommercialAccountingError('The evidence document does not belong to this tenant.')
    const journal = await transaction.journalEntry.findFirst({ where: { ownerId, id: input.postingJournalEntryId, state: 'POSTED' } })
    if (!journal) throw new CommercialAccountingError('The posting journal entry does not belong to this tenant or is not posted.')
    const issueDate = new Date(`${input.issueDate}T00:00:00.000Z`)
    if (Number.isNaN(issueDate.valueOf()) || issueDate.toISOString().slice(0, 10) !== input.issueDate) throw new CommercialAccountingError('issueDate must be an ISO calendar date.')
    const documentNumber = required(input.documentNumber, 'documentNumber')
    const authoritativeIssuer = draft.direction === 'RECEIVABLE' ? ownerId : draft.businessPartner.vatId || draft.businessPartner.taxId || [draft.businessPartner.name, draft.businessPartner.street, draft.businessPartner.houseNumber, draft.businessPartner.postalCode, draft.businessPartner.city, draft.businessPartner.countryCode].filter(Boolean).join('|')
    const identity = commercialDocumentIdentity(draft.direction as DocumentDirection, authoritativeIssuer, documentNumber)
    const snapshot = JSON.stringify({ partnerNumber: draft.businessPartner.partnerNumber, name: draft.businessPartner.name, vatId: draft.businessPartner.vatId, taxId: draft.businessPartner.taxId, street: draft.businessPartner.street, houseNumber: draft.businessPartner.houseNumber, postalCode: draft.businessPartner.postalCode, city: draft.businessPartner.city, countryCode: draft.businessPartner.countryCode })
    const claimed = await transaction.commercialDocument.updateMany({ where: { ownerId, id: draft.id, status: 'DRAFT', version: draft.version }, data: { status: 'POSTED', documentNumber, documentIdentityKey: identity, issueDate, evidenceDocumentId: evidence.id, postingJournalEntryId: journal.id, structuredInvoiceId: input.structuredInvoiceId ?? null, counterpartySnapshot: snapshot, version: { increment: 1 } } })
    if (claimed.count !== 1) throw new CommercialAccountingError('The commercial document draft changed concurrently.')
    if (draft.payableAmountCents > 0) await transaction.openItem.create({ data: { ownerId, commercialDocumentId: draft.id, side: draft.kind === 'INVOICE' ? draft.direction === 'RECEIVABLE' ? 'DEBIT' : 'CREDIT' : draft.direction === 'RECEIVABLE' ? 'CREDIT' : 'DEBIT', currency: draft.currency, originalAmountCents: draft.payableAmountCents } })
    const finalized = await transaction.commercialDocument.findUniqueOrThrow({ where: { id: draft.id }, include: { openItem: true } })
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'COMMERCIAL_DOCUMENT_POSTED', reason: input.reason, objectType: 'CommercialDocument', objectId: draft.id, before: draft, after: finalized })
    return finalized
  })
}

function settlementHash(input: { openItemId: string; settlementId: string; journalEntryId?: string; amountCents: number; effectiveDate: string; reversesAllocationId?: string }) {
  return createHash('sha256').update(JSON.stringify({ openItemId: input.openItemId, settlementId: input.settlementId, journalEntryId: input.journalEntryId ?? null, amountCents: input.amountCents, effectiveDate: input.effectiveDate, reversesAllocationId: input.reversesAllocationId ?? null })).digest('hex')
}

export async function allocateSettlement(ownerId: string, actorId: string, requestKey: string, input: { openItemId: string; settlementId: string; journalEntryId?: string; amountCents: number; effectiveDate: string; reversesAllocationId?: string; reason: string }) {
  required(ownerId, 'ownerId'); required(actorId, 'actorId'); required(requestKey, 'requestKey'); required(input.reason, 'reason')
  if (!/^[A-Za-z0-9._:-]{16,100}$/.test(requestKey)) throw new CommercialAccountingError('Settlement idempotency key must contain 16-100 safe characters.')
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents === 0) throw new CommercialAccountingError('Settlement amount must be a non-zero integer number of cents.')
  const effectiveDate = new Date(`${input.effectiveDate}T00:00:00.000Z`)
  if (Number.isNaN(effectiveDate.valueOf()) || effectiveDate.toISOString().slice(0, 10) !== input.effectiveDate) throw new CommercialAccountingError('effectiveDate must be an ISO calendar date.')
  const hash = settlementHash(input)
  return prisma.$transaction(async transaction => {
    const existing = await transaction.settlementAllocation.findUnique({ where: { ownerId_requestKey: { ownerId, requestKey } } })
    if (existing) {
      if (existing.requestHash !== hash) throw new CommercialAccountingError('The settlement request key was already used with different facts.')
      return existing
    }
    const settlement = await transaction.paymentSettlement.findFirst({ where: { ownerId, id: input.settlementId } })
    if (!settlement) throw new CommercialAccountingError('The payment settlement does not belong to this tenant.')
    const journalEntryId = input.reversesAllocationId ? required(input.journalEntryId ?? '', 'reversal journal entry') : settlement.journalEntryId
    const created = await transaction.settlementAllocation.create({ data: { ownerId, openItemId: input.openItemId, settlementId: settlement.id, journalEntryId, kind: input.reversesAllocationId ? 'REVERSAL' : 'APPLY', amountCents: input.amountCents, requestKey, requestHash: hash, reversesAllocationId: input.reversesAllocationId ?? null, effectiveDate, createdBy: actorId } })
    await appendAuditEvent(transaction, { ownerId, actorId, action: input.reversesAllocationId ? 'SETTLEMENT_REVERSED' : 'SETTLEMENT_ALLOCATED', reason: input.reason, objectType: 'SettlementAllocation', objectId: created.id, after: created })
    return created
  })
}

export async function listOpenItems(ownerId: string) {
  return prisma.openItem.findMany({ where: { ownerId }, include: { commercialDocument: { include: { businessPartner: true } }, allocations: { orderBy: { createdAt: 'asc' } } }, orderBy: [{ status: 'asc' }, { createdAt: 'asc' }] })
}
