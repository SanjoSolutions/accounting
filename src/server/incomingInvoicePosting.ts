import 'server-only'

import { createHash, randomUUID } from 'node:crypto'
import { calculateVat } from '@/core/vatEngine'
import { incomingInvoicePostingLines, parseIsoDate } from '@/core/incomingInvoicePosting'
import { validateReviewedInvoiceExtraction } from '@/core/documentExtraction'
import { recommendIncomingInvoiceExpenseAccount } from '@/core/incomingInvoiceExpenseAccount'
import { structuredIncomingInvoiceFacts, type StructuredIncomingVatGroup } from '@/core/structuredIncomingInvoice'
import { classifyDomesticGermanReverseCharge, parseIncomingReverseChargeAccounts } from '@/core/incomingReverseCharge'
import { appendAuditEvent } from '@/server/compliance/auditPersistence'
import { commercialDocumentIdentity } from '@/server/commercialAccountingRepository'
import { prisma } from '@/server/persistence/client'
import { germanVatRuleBook, journalLineVatData, vatPostingCreateData } from '@/server/tax/vatPostingCalculation'

export class IncomingInvoicePostingError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

const includePosting = { businessPartner: true, openItem: true, postingJournalEntry: { include: { lines: { include: { account: true, vatPosting: true } }, documents: true } } } as const

export async function getIncomingInvoicePostingContext(ownerId: string, documentId: string) {
  const extraction = await prisma.documentExtraction.findFirst({ where: { ownerId, documentId, status: 'CONFIRMED' } })
  if (!extraction) throw new IncomingInvoicePostingError('A confirmed invoice extraction is required before posting.', 409)
  const existing = await prisma.commercialDocument.findFirst({ where: { ownerId, evidenceDocumentId: documentId, direction: 'PAYABLE', kind: 'INVOICE' }, include: includePosting })
  const [expenseAccounts, profile, structured, settings] = await Promise.all([
    prisma.ledgerAccount.findMany({ where: { ownerId, active: true, category: 'EXPENSE' }, select: { id: true, number: true, name: true, eBilanzPosition: true }, orderBy: { number: 'asc' } }),
    prisma.ledgerProfile.findUnique({ where: { ownerId }, select: { chart: true, accountLength: true } }),
    prisma.structuredInvoice.findFirst({ where: { ownerId, documentId, direction: 'INCOMING' }, select: { data: true } }),
    prisma.accountRecord.findUnique({ where: { ownerId }, select: { payload: true } }),
  ])
  const recommendedExpenseAccountId = recommendIncomingInvoiceExpenseAccount(profile?.chart, profile?.accountLength, expenseAccounts)
  const reverseCharge = structured ? classifyDomesticGermanReverseCharge(JSON.parse(structured.data)) : null
  const configured = settings ? parseIncomingReverseChargeAccounts((JSON.parse(settings.payload) as Record<string, unknown>).incomingReverseChargeAccounts) : null
  const controls = reverseCharge && configured && configured.chart === profile?.chart
    ? await prisma.ledgerAccount.findMany({ where: { ownerId, active: true, number: { in: [configured.inputVatAccountNumber, configured.outputVatAccountNumber] } }, select: { number: true, category: true } })
    : []
  const controlsReady = Boolean(configured
    && controls.some(account => account.number === configured.inputVatAccountNumber && account.category === 'ASSET')
    && controls.some(account => account.number === configured.outputVatAccountNumber && account.category === 'LIABILITY'))
  return { posting: existing, expenseAccounts, recommendedExpenseAccountId, reverseChargeTreatment: reverseCharge ? { ...reverseCharge, configured: controlsReady } : null }
}

export async function postConfirmedIncomingInvoice(ownerId: string, actorId: string, documentId: string, input: { expenseAccountId: string; dueDate: string; reason: string; reverseChargeRateBasisPoints?: number }) {
  if (!ownerId || !actorId) throw new IncomingInvoicePostingError('Authenticated tenant and actor are required.', 401)
  if (!input?.expenseAccountId?.trim()) throw new IncomingInvoicePostingError('An expense account is required.')
  if (!input.reason?.trim()) throw new IncomingInvoicePostingError('A posting confirmation reason is required.')
  const dueDate = parseIsoDate(input.dueDate, 'Due date')
  const externalKey = `INCOMING-INVOICE:${createHash('sha256').update(`${ownerId}:${documentId}`).digest('hex')}`

  const run = () => prisma.$transaction(async transaction => {
    const priorJournal = await transaction.journalEntry.findUnique({ where: { externalKey } })
    if (priorJournal) {
      const prior = await transaction.commercialDocument.findFirst({ where: { ownerId, postingJournalEntryId: priorJournal.id }, include: includePosting })
      if (!prior) throw new IncomingInvoicePostingError('The idempotent invoice journal exists without its commercial document.', 409)
      return prior
    }
    const extraction = await transaction.documentExtraction.findFirst({ where: { ownerId, documentId, status: 'CONFIRMED' } })
    if (!extraction?.extractedData || !extraction.reviewedAt) throw new IncomingInvoicePostingError('A human-confirmed invoice extraction is required before posting.', 409)
    await transaction.documentExtraction.updateMany({ where: { id: extraction.id, ownerId, status: 'CONFIRMED' }, data: { updatedAt: new Date() } })
    const structured = await transaction.structuredInvoice.findFirst({ where: { ownerId, documentId, direction: 'INCOMING' } })
    const structuredFacts = structured ? structuredIncomingInvoiceFacts(JSON.parse(structured.data), { reverseChargeRateBasisPoints: input.reverseChargeRateBasisPoints }) : null
    const invoice = structuredFacts?.extraction ?? validateReviewedInvoiceExtraction(JSON.parse(extraction.extractedData))
    if (!structuredFacts) incomingInvoicePostingLines(invoice)
    const vatGroups: StructuredIncomingVatGroup[] = structuredFacts?.vatGroups ?? [{ rateBasisPoints: invoice.taxAmountCents ? 1900 : 0, invoiceRateBasisPoints: invoice.taxAmountCents ? 1900 : 0, netAmountCents: invoice.netAmountCents, taxAmountCents: invoice.taxAmountCents, supplierTaxAmountCents: invoice.taxAmountCents, ruleId: invoice.taxAmountCents ? 'DE_STANDARD' : 'DE_ZERO' }]
    const issueDate = parseIsoDate(invoice.issueDate, 'Issue date')
    if (dueDate < issueDate) throw new IncomingInvoicePostingError('Due date cannot be before the invoice date.')
    const periods = await transaction.fiscalYear.findMany({ where: { ownerId, status: 'OPEN', startsAt: { lte: issueDate }, endsAt: { gte: issueDate } } })
    if (periods.length !== 1) throw new IncomingInvoicePostingError('Exactly one open fiscal year must cover the invoice date.', 409)
    const period = periods[0]
    await transaction.fiscalYear.updateMany({ where: { ownerId, id: period.id, status: 'OPEN' }, data: { updatedAt: new Date() } })
    const profile = await transaction.ledgerProfile.findUnique({ where: { ownerId } })
    if (!profile || !['SKR03', 'SKR04'].includes(profile.chart)) throw new IncomingInvoicePostingError('An active SKR03 or SKR04 ledger profile is required.', 409)
    const scale = 10 ** ((profile.accountLength ?? 4) - 4)
    const payableNumber = (profile.chart === 'SKR04' ? 3300 : 1600) * scale
    const standardInputVatNumbers = [...new Set(vatGroups.filter(group => group.taxAmountCents && group.ruleId !== 'DE_13B').map(group => (profile.chart === 'SKR04' ? group.rateBasisPoints === 700 ? 1401 : 1406 : group.rateBasisPoints === 700 ? 1571 : 1576) * scale))]
    const settings = structuredFacts?.reverseCharge ? await transaction.accountRecord.findUnique({ where: { ownerId }, select: { payload: true } }) : null
    const reverseChargeAccounts = settings ? parseIncomingReverseChargeAccounts((JSON.parse(settings.payload) as Record<string, unknown>).incomingReverseChargeAccounts) : null
    if (structuredFacts?.reverseCharge && (!reverseChargeAccounts || reverseChargeAccounts.chart !== profile.chart)) throw new IncomingInvoicePostingError('Explicit active-chart §13b input and output VAT control accounts are required.', 409)
    const configuredControlNumbers = reverseChargeAccounts ? [reverseChargeAccounts.inputVatAccountNumber, reverseChargeAccounts.outputVatAccountNumber] : []
    const [expense, payables, inputVatAccounts, reverseChargeControlAccounts] = await Promise.all([
      transaction.ledgerAccount.findFirst({ where: { ownerId, id: input.expenseAccountId, active: true, category: 'EXPENSE' } }),
      transaction.ledgerAccount.findFirst({ where: { ownerId, number: payableNumber, active: true, category: 'LIABILITY' } }),
      transaction.ledgerAccount.findMany({ where: { ownerId, number: { in: standardInputVatNumbers }, active: true, category: 'ASSET' } }),
      transaction.ledgerAccount.findMany({ where: { ownerId, number: { in: configuredControlNumbers }, active: true } }),
    ])
    if (!expense) throw new IncomingInvoicePostingError('The selected active expense account does not belong to this tenant.', 409)
    if (!payables || inputVatAccounts.length !== standardInputVatNumbers.length) throw new IncomingInvoicePostingError('The active trade-payables and rate-specific input-VAT control accounts must be configured.', 409)
    const reverseChargeInput = reverseChargeAccounts && reverseChargeControlAccounts.find(account => account.number === reverseChargeAccounts.inputVatAccountNumber && account.category === 'ASSET')
    const reverseChargeOutput = reverseChargeAccounts && reverseChargeControlAccounts.find(account => account.number === reverseChargeAccounts.outputVatAccountNumber && account.category === 'LIABILITY')
    if (structuredFacts?.reverseCharge && (!reverseChargeInput || !reverseChargeOutput)) throw new IncomingInvoicePostingError('Configured §13b controls must be active input-VAT asset and output-VAT liability accounts.', 409)

    const partnerNumber = `L-${createHash('sha256').update(invoice.supplierName.normalize('NFKC').trim().toLocaleUpperCase('de-DE')).digest('hex').slice(0, 10).toUpperCase()}`
    let partner = await transaction.businessPartner.findUnique({ where: { ownerId_partnerNumber: { ownerId, partnerNumber } } })
    if (!partner) partner = await transaction.businessPartner.create({ data: { ownerId, partnerNumber, role: 'SUPPLIER', name: invoice.supplierName } })
    else if (partner.role === 'CUSTOMER') partner = await transaction.businessPartner.update({ where: { id: partner.id }, data: { role: 'BOTH', version: { increment: 1 } } })
    else if (!partner.active) throw new IncomingInvoicePostingError('The matching supplier is inactive.', 409)

    const identity = commercialDocumentIdentity('PAYABLE', partner.vatId || partner.taxId || partner.name, invoice.invoiceNumber)
    const duplicate = await transaction.commercialDocument.findUnique({ where: { ownerId_direction_documentIdentityKey: { ownerId, direction: 'PAYABLE', documentIdentityKey: identity } }, include: includePosting })
    if (duplicate) {
      if (duplicate.evidenceDocumentId === documentId) return duplicate
      throw new IncomingInvoicePostingError('This supplier invoice number has already been posted with different evidence.', 409)
    }
    const last = await transaction.journalEntry.findFirst({ where: { fiscalYearId: period.id }, orderBy: { sequenceNumber: 'desc' }, select: { sequenceNumber: true } })
    const digest = createHash('sha256').update(`${ownerId}:${documentId}`).digest('hex').slice(0, 10).toUpperCase()
    const vatDetails = vatGroups.map(group => ({ group, lineId: randomUUID(), detail: calculateVat({ ownerId, sourceId: `incoming-invoice:${documentId}:vat:${group.rateBasisPoints}`, amountCents: group.netAmountCents, mode: 'net', taxPoint: invoice.issueDate, ruleId: group.ruleId, direction: 'purchase' }, germanVatRuleBook) }))
    if (vatDetails.some(({ group, detail }) => detail.netBaseCents !== group.netAmountCents || detail.inputTaxCents !== group.taxAmountCents || group.ruleId === 'DE_13B' && detail.outputTaxCents !== group.taxAmountCents)) throw new IncomingInvoicePostingError('Structured VAT buckets do not match canonical German VAT calculation.', 409)
    const inputVatByNumber = new Map(inputVatAccounts.map(account => [account.number, account]))
    const journal = await transaction.journalEntry.create({ data: {
      ownerId, fiscalYearId: period.id, sequenceNumber: (last?.sequenceNumber ?? 0) + 1, bookingDate: issueDate,
      documentNumber: `ER-${invoice.invoiceNumber.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 30)}-${digest}`, description: `${invoice.supplierName}: ${invoice.invoiceNumber}`,
      source: 'INCOMING_INVOICE', externalKey,
      lines: { create: [
        ...vatDetails.map(({ group, lineId, detail }) => ({ id: lineId, accountId: expense.id, debitCents: group.netAmountCents, creditCents: 0, ...journalLineVatData(detail) })),
        ...vatDetails.filter(({ group }) => group.taxAmountCents && group.ruleId !== 'DE_13B').map(({ group }) => { const number = (profile.chart === 'SKR04' ? group.rateBasisPoints === 700 ? 1401 : 1406 : group.rateBasisPoints === 700 ? 1571 : 1576) * scale; return { accountId: inputVatByNumber.get(number)!.id, debitCents: group.taxAmountCents, creditCents: 0 } }),
        ...vatDetails.filter(({ group }) => group.ruleId === 'DE_13B').flatMap(({ detail }) => [{ accountId: reverseChargeInput!.id, debitCents: detail.inputTaxCents, creditCents: 0 }, { accountId: reverseChargeOutput!.id, debitCents: 0, creditCents: detail.outputTaxCents }]),
        { accountId: payables.id, debitCents: 0, creditCents: invoice.grossAmountCents },
      ] },
      documents: { create: { documentId } },
    } })
    for (const { lineId, detail } of vatDetails) await transaction.vatPostingRecord.create({ data: vatPostingCreateData(ownerId, lineId, detail, documentId) })
    const commercial = await transaction.commercialDocument.create({ data: {
      ownerId, businessPartnerId: partner.id, structuredInvoiceId: structured?.id, evidenceDocumentId: documentId, postingJournalEntryId: journal.id,
      direction: 'PAYABLE', kind: 'INVOICE', status: 'POSTED', documentNumber: invoice.invoiceNumber, documentIdentityKey: identity,
      issueDate, serviceDate: issueDate, dueDate, description: `${invoice.supplierName}: ${invoice.invoiceNumber}`, currency: 'EUR',
      netAmountCents: invoice.netAmountCents, taxAmountCents: invoice.taxAmountCents, grossAmountCents: invoice.grossAmountCents, payableAmountCents: invoice.grossAmountCents,
      counterpartySnapshot: JSON.stringify({ partnerNumber: partner.partnerNumber, name: partner.name }),
      openItem: { create: { side: 'CREDIT', currency: 'EUR', originalAmountCents: invoice.grossAmountCents } },
    }, include: includePosting })
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'INCOMING_INVOICE_POSTED', reason: input.reason, objectType: 'CommercialDocument', objectId: commercial.id, after: { extractionId: extraction.id, evidenceDocumentId: documentId, journalEntryId: journal.id, openItemId: commercial.openItem?.id, invoice, reverseCharge: structuredFacts?.reverseCharge ?? false, vatRuleIds: vatDetails.map(item => item.detail.ruleId) } })
    return commercial
  })
  try { return await run() }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
      const winner = await prisma.journalEntry.findUnique({ where: { externalKey } })
      if (winner) {
        const commercial = await prisma.commercialDocument.findFirst({ where: { ownerId, postingJournalEntryId: winner.id }, include: includePosting })
        if (commercial) return commercial
      }
    }
    throw error
  }
}
