import 'server-only'

import { createHash, randomUUID } from 'node:crypto'
import { calculateVat, originalVatPostingMarkers } from '@/core/vatEngine'
import { incomingInvoicePostingLines, parseIsoDate } from '@/core/incomingInvoicePosting'
import { validateReviewedInvoiceExtraction } from '@/core/documentExtraction'
import { recommendIncomingInvoiceExpenseAccount } from '@/core/incomingInvoiceExpenseAccount'
import { structuredIncomingInvoiceFacts, type StructuredIncomingVatGroup } from '@/core/structuredIncomingInvoice'
import { classifyIncomingGermanReverseCharge, parseIncomingEuAcquisitionAccounts, parseIncomingReverseChargeAccounts } from '@/core/incomingReverseCharge'
import { acquisitionVatTaxPoint, classifyIncomingEuGoodsAcquisition, isIncomingEuGoodsAcquisitionCandidate } from '@/core/incomingEuAcquisition'
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
  const structuredData = structured ? JSON.parse(structured.data) : null
  const recipientAssessedVat = structuredData ? (isIncomingEuGoodsAcquisitionCandidate(structuredData) ? classifyIncomingEuGoodsAcquisition(structuredData) : classifyIncomingGermanReverseCharge(structuredData)) : null
  const settingsPayload = settings ? JSON.parse(settings.payload) as Record<string, unknown> : null
  const configured = recipientAssessedVat?.kind === 'DE_EU_GOODS_ACQUISITION'
    ? parseIncomingEuAcquisitionAccounts(settingsPayload?.incomingEuAcquisitionAccounts)
    : parseIncomingReverseChargeAccounts(settingsPayload?.incomingReverseChargeAccounts)
  const controls = recipientAssessedVat && configured && configured.chart === profile?.chart
    ? await prisma.ledgerAccount.findMany({ where: { ownerId, active: true, number: { in: [configured.inputVatAccountNumber, configured.outputVatAccountNumber] } }, select: { number: true, category: true } })
    : []
  const controlsReady = Boolean(configured
    && controls.some(account => account.number === configured.inputVatAccountNumber && account.category === 'ASSET')
    && controls.some(account => account.number === configured.outputVatAccountNumber && account.category === 'LIABILITY'))
  return { posting: existing, expenseAccounts, recommendedExpenseAccountId, recipientAssessedVatTreatment: recipientAssessedVat ? { ...recipientAssessedVat, configured: controlsReady } : null }
}

export async function postConfirmedIncomingInvoice(ownerId: string, actorId: string, documentId: string, input: { expenseAccountId: string; dueDate: string; reason: string; assessmentRateBasisPoints?: number; supplyClassification?: 'SERVICE' | 'STANDARD_GOODS'; reverseChargeRateBasisPoints?: number; reverseChargeSupplyKind?: 'SERVICE' }) {
  if (!ownerId || !actorId) throw new IncomingInvoicePostingError('Authenticated tenant and actor are required.', 401)
  if (!input?.expenseAccountId?.trim()) throw new IncomingInvoicePostingError('An expense account is required.')
  if (!input.reason?.trim()) throw new IncomingInvoicePostingError('A posting confirmation reason is required.')
  const dueDate = parseIsoDate(input.dueDate, 'Due date')
  const externalKey = `INCOMING-INVOICE:${createHash('sha256').update(`${ownerId}:${documentId}`).digest('hex')}`
  const assessmentRateBasisPoints = input.assessmentRateBasisPoints ?? input.reverseChargeRateBasisPoints
  const supplyClassification = input.supplyClassification ?? input.reverseChargeSupplyKind
  const commandFingerprint = incomingPostingCommandFingerprint({ expenseAccountId: input.expenseAccountId.trim(), dueDate: input.dueDate, reason: input.reason.trim(), assessmentRateBasisPoints, supplyClassification })

  const run = () => prisma.$transaction(async transaction => {
    const priorJournal = await transaction.journalEntry.findUnique({ where: { externalKey } })
    if (priorJournal) {
      const prior = await transaction.commercialDocument.findFirst({ where: { ownerId, postingJournalEntryId: priorJournal.id }, include: includePosting })
      if (!prior) throw new IncomingInvoicePostingError('The idempotent invoice journal exists without its commercial document.', 409)
      const priorRuleIds = prior.postingJournalEntry?.lines.flatMap(line => line.vatPosting?.ruleId ? [line.vatPosting.ruleId] : []) ?? []
      if (priorRuleIds.some(isCrossBorderRecipientAssessedRule)) await requireMatchingEuRecipientAssessedReplay(transaction, ownerId, prior.id, commandFingerprint)
      return prior
    }
    const extraction = await transaction.documentExtraction.findFirst({ where: { ownerId, documentId, status: 'CONFIRMED' } })
    if (!extraction?.extractedData || !extraction.reviewedAt) throw new IncomingInvoicePostingError('A human-confirmed invoice extraction is required before posting.', 409)
    await transaction.documentExtraction.updateMany({ where: { id: extraction.id, ownerId, status: 'CONFIRMED' }, data: { updatedAt: new Date() } })
    const structured = await transaction.structuredInvoice.findFirst({ where: { ownerId, documentId, direction: 'INCOMING' } })
    const structuredData = structured ? JSON.parse(structured.data) : null
    const structuredFacts = structuredData ? structuredIncomingInvoiceFacts(structuredData, { assessmentRateBasisPoints, supplyClassification }) : null
    const invoice = structuredFacts?.extraction ?? validateReviewedInvoiceExtraction(JSON.parse(extraction.extractedData))
    if (!structuredFacts) incomingInvoicePostingLines(invoice)
    const vatGroups: StructuredIncomingVatGroup[] = structuredFacts?.vatGroups ?? [{ rateBasisPoints: invoice.taxAmountCents ? 1900 : 0, invoiceRateBasisPoints: invoice.taxAmountCents ? 1900 : 0, netAmountCents: invoice.netAmountCents, taxAmountCents: invoice.taxAmountCents, supplierTaxAmountCents: invoice.taxAmountCents, ruleId: invoice.taxAmountCents ? 'DE_STANDARD' : 'DE_ZERO' }]
    const issueDate = parseIsoDate(invoice.issueDate, 'Issue date')
    if (dueDate < issueDate) throw new IncomingInvoicePostingError('Due date cannot be before the invoice date.')
    const euService = vatGroups.some(group => group.ruleId === 'EU_13B_SERVICE_RECIPIENT')
    const euAcquisition = vatGroups.some(group => group.ruleId === 'EU_ACQUISITION')
    const euCrossBorder = euService || euAcquisition
    const taxPointText = euService ? structuredData?.supplyDate : euAcquisition ? acquisitionVatTaxPoint(structuredData.supplyDate, invoice.issueDate) : invoice.issueDate
    const taxPoint = parseIsoDate(taxPointText, euService ? 'EU-service supply date' : euAcquisition ? 'intra-EU acquisition VAT date' : 'Issue date')
    const periods = await transaction.fiscalYear.findMany({ where: { ownerId, status: 'OPEN', startsAt: { lte: taxPoint }, endsAt: { gte: taxPoint } } })
    if (periods.length !== 1) throw new IncomingInvoicePostingError(`Exactly one open fiscal year must cover the ${euService ? 'EU-service supply' : euAcquisition ? 'intra-EU acquisition VAT' : 'invoice'} date.`, 409)
    const period = periods[0]
    await transaction.fiscalYear.updateMany({ where: { ownerId, id: period.id, status: 'OPEN' }, data: { updatedAt: new Date() } })
    const profile = await transaction.ledgerProfile.findUnique({ where: { ownerId } })
    if (!profile || !['SKR03', 'SKR04'].includes(profile.chart)) throw new IncomingInvoicePostingError('An active SKR03 or SKR04 ledger profile is required.', 409)
    const scale = 10 ** ((profile.accountLength ?? 4) - 4)
    const payableNumber = (profile.chart === 'SKR04' ? 3300 : 1600) * scale
    const standardInputVatNumbers = [...new Set(vatGroups.filter(group => group.taxAmountCents && !isRecipientAssessedVat(group.ruleId)).map(group => (profile.chart === 'SKR04' ? group.rateBasisPoints === 700 ? 1401 : 1406 : group.rateBasisPoints === 700 ? 1571 : 1576) * scale))]
    const settings = structuredFacts?.recipientAssessedVat ? await transaction.accountRecord.findUnique({ where: { ownerId }, select: { payload: true } }) : null
    const settingsPayload = settings ? JSON.parse(settings.payload) as Record<string, unknown> : null
    const recipientAssessedAccounts = settingsPayload ? (euAcquisition ? parseIncomingEuAcquisitionAccounts(settingsPayload.incomingEuAcquisitionAccounts) : parseIncomingReverseChargeAccounts(settingsPayload.incomingReverseChargeAccounts)) : null
    if (structuredFacts?.recipientAssessedVat && (!recipientAssessedAccounts || recipientAssessedAccounts.chart !== profile.chart)) throw new IncomingInvoicePostingError(`Explicit active-chart ${euAcquisition ? 'intra-EU acquisition' : '§13b'} input and output VAT control accounts are required.`, 409)
    if (euCrossBorder) {
      const tenantVatId = normalizeVatId((settingsPayload?.companyProfile as { vatId?: unknown } | undefined)?.vatId)
      const buyerVatId = normalizeVatId(structuredData?.buyer?.vatId)
      if (!tenantVatId || tenantVatId !== buyerVatId) throw new IncomingInvoicePostingError(`The ${euAcquisition ? 'intra-EU acquisition' : 'EU-service'} invoice buyer VAT ID must exactly match the authenticated tenant company profile.`, 409)
    }
    const configuredControlNumbers = recipientAssessedAccounts ? [recipientAssessedAccounts.inputVatAccountNumber, recipientAssessedAccounts.outputVatAccountNumber] : []
    const [expense, payables, inputVatAccounts, reverseChargeControlAccounts] = await Promise.all([
      transaction.ledgerAccount.findFirst({ where: { ownerId, id: input.expenseAccountId, active: true, category: 'EXPENSE' } }),
      transaction.ledgerAccount.findFirst({ where: { ownerId, number: payableNumber, active: true, category: 'LIABILITY' } }),
      transaction.ledgerAccount.findMany({ where: { ownerId, number: { in: standardInputVatNumbers }, active: true, category: 'ASSET' } }),
      transaction.ledgerAccount.findMany({ where: { ownerId, number: { in: configuredControlNumbers }, active: true } }),
    ])
    if (!expense) throw new IncomingInvoicePostingError('The selected active expense account does not belong to this tenant.', 409)
    if (!payables || inputVatAccounts.length !== standardInputVatNumbers.length) throw new IncomingInvoicePostingError('The active trade-payables and rate-specific input-VAT control accounts must be configured.', 409)
    const recipientAssessedInput = recipientAssessedAccounts && reverseChargeControlAccounts.find(account => account.number === recipientAssessedAccounts.inputVatAccountNumber && account.category === 'ASSET')
    const recipientAssessedOutput = recipientAssessedAccounts && reverseChargeControlAccounts.find(account => account.number === recipientAssessedAccounts.outputVatAccountNumber && account.category === 'LIABILITY')
    if (structuredFacts?.recipientAssessedVat && (!recipientAssessedInput || !recipientAssessedOutput)) throw new IncomingInvoicePostingError(`Configured ${euAcquisition ? 'intra-EU acquisition' : '§13b'} controls must be active input-VAT asset and output-VAT liability accounts.`, 409)

    const supplierVatId = euCrossBorder ? normalizeVatId(structuredData?.seller?.vatId) : ''
    const partnerKey = supplierVatId || invoice.supplierName.normalize('NFKC').trim().toLocaleUpperCase('de-DE')
    const partnerNumber = `L-${createHash('sha256').update(partnerKey).digest('hex').slice(0, 10).toUpperCase()}`
    let partner = euCrossBorder ? await transaction.businessPartner.findFirst({ where: { ownerId, vatId: supplierVatId } }) : await transaction.businessPartner.findUnique({ where: { ownerId_partnerNumber: { ownerId, partnerNumber } } })
    const supplierParty = euCrossBorder ? { name: structuredData.seller.name, street: structuredData.seller.street, postalCode: structuredData.seller.postalCode, city: structuredData.seller.city, countryCode: structuredData.seller.countryCode, vatId: supplierVatId } : { name: invoice.supplierName }
    if (!partner) partner = await transaction.businessPartner.create({ data: { ownerId, partnerNumber, role: 'SUPPLIER', ...supplierParty } })
    else if (euCrossBorder && (!partner.active || partner.vatId !== supplierVatId)) throw new IncomingInvoicePostingError('The matching EU supplier VAT master record is inactive or inconsistent.', 409)
    else if (euCrossBorder) partner = await transaction.businessPartner.update({ where: { id: partner.id }, data: { ...supplierParty, ...(partner.role === 'CUSTOMER' ? { role: 'BOTH' } : {}), version: { increment: 1 } } })
    else if (partner.role === 'CUSTOMER') partner = await transaction.businessPartner.update({ where: { id: partner.id }, data: { role: 'BOTH', version: { increment: 1 } } })
    else if (!partner.active) throw new IncomingInvoicePostingError('The matching supplier is inactive.', 409)

    const identity = commercialDocumentIdentity('PAYABLE', supplierVatId || partner.vatId || partner.taxId || partner.name, invoice.invoiceNumber)
    const duplicate = await transaction.commercialDocument.findUnique({ where: { ownerId_direction_documentIdentityKey: { ownerId, direction: 'PAYABLE', documentIdentityKey: identity } }, include: includePosting })
    if (duplicate) {
      if (duplicate.evidenceDocumentId === documentId) return duplicate
      throw new IncomingInvoicePostingError('This supplier invoice number has already been posted with different evidence.', 409)
    }
    const last = await transaction.journalEntry.findFirst({ where: { fiscalYearId: period.id }, orderBy: { sequenceNumber: 'desc' }, select: { sequenceNumber: true } })
    const digest = createHash('sha256').update(`${ownerId}:${documentId}`).digest('hex').slice(0, 10).toUpperCase()
    const vatDetails = vatGroups.map(group => ({ group, lineId: randomUUID(), detail: calculateVat({ ownerId, sourceId: `incoming-invoice:${documentId}:vat:${group.rateBasisPoints}`, amountCents: group.netAmountCents, mode: 'net', taxPoint: taxPointText, ruleId: group.ruleId, direction: 'purchase', ...(group.ruleId === 'EU_ACQUISITION' ? { supplyKind: 'goods' as const } : {}) }, germanVatRuleBook) }))
    if (vatDetails.some(({ group, detail }) => detail.netBaseCents !== group.netAmountCents || detail.inputTaxCents !== group.taxAmountCents || isRecipientAssessedVat(group.ruleId) && detail.outputTaxCents !== group.taxAmountCents)) throw new IncomingInvoicePostingError('Structured VAT buckets do not match canonical German VAT calculation.', 409)
    const inputVatByNumber = new Map(inputVatAccounts.map(account => [account.number, account]))
    const journal = await transaction.journalEntry.create({ data: {
      ownerId, fiscalYearId: period.id, sequenceNumber: (last?.sequenceNumber ?? 0) + 1, bookingDate: taxPoint,
      documentNumber: `ER-${invoice.invoiceNumber.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 30)}-${digest}`, description: `${invoice.supplierName}: ${invoice.invoiceNumber}`,
      source: 'INCOMING_INVOICE', externalKey,
      lines: { create: [
        ...vatDetails.map(({ group, lineId, detail }) => ({ id: lineId, accountId: expense.id, debitCents: group.netAmountCents, creditCents: 0, ...journalLineVatData(detail) })),
        ...vatDetails.filter(({ group }) => group.taxAmountCents && !isRecipientAssessedVat(group.ruleId)).map(({ group }) => { const number = (profile.chart === 'SKR04' ? group.rateBasisPoints === 700 ? 1401 : 1406 : group.rateBasisPoints === 700 ? 1571 : 1576) * scale; return { accountId: inputVatByNumber.get(number)!.id, debitCents: group.taxAmountCents, creditCents: 0 } }),
        ...vatDetails.filter(({ group }) => isRecipientAssessedVat(group.ruleId)).flatMap(({ detail }) => [{ accountId: recipientAssessedInput!.id, debitCents: detail.inputTaxCents, creditCents: 0 }, { accountId: recipientAssessedOutput!.id, debitCents: 0, creditCents: detail.outputTaxCents }]),
        { accountId: payables.id, debitCents: 0, creditCents: invoice.grossAmountCents },
      ] },
      documents: { create: { documentId } },
    } })
    for (const { lineId, detail } of vatDetails) await transaction.vatPostingRecord.create({ data: vatPostingCreateData(ownerId, lineId, detail, documentId) })
    await transaction.vatReversalMarker.createMany({ data: vatDetails.flatMap(({ detail }) => originalVatPostingMarkers(detail).map(marker => ({ ownerId, marker }))) })
    const commercial = await transaction.commercialDocument.create({ data: {
      ownerId, businessPartnerId: partner.id, structuredInvoiceId: structured?.id, evidenceDocumentId: documentId, postingJournalEntryId: journal.id,
      direction: 'PAYABLE', kind: 'INVOICE', status: 'POSTED', documentNumber: invoice.invoiceNumber, documentIdentityKey: identity,
      issueDate, serviceDate: euCrossBorder ? parseIsoDate(structuredData.supplyDate, euAcquisition ? 'Acquisition date' : 'EU-service supply date') : taxPoint, dueDate, description: `${invoice.supplierName}: ${invoice.invoiceNumber}`, currency: 'EUR',
      netAmountCents: invoice.netAmountCents, taxAmountCents: invoice.taxAmountCents, grossAmountCents: invoice.grossAmountCents, payableAmountCents: invoice.grossAmountCents,
      counterpartySnapshot: JSON.stringify({ partnerNumber: partner.partnerNumber, name: structuredData?.seller?.name ?? partner.name, vatId: partner.vatId, street: partner.street, postalCode: partner.postalCode, city: partner.city, countryCode: partner.countryCode }),
      openItem: { create: { side: 'CREDIT', currency: 'EUR', originalAmountCents: invoice.grossAmountCents } },
    }, include: includePosting })
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'INCOMING_INVOICE_POSTED', reason: input.reason, objectType: 'CommercialDocument', objectId: commercial.id, after: { extractionId: extraction.id, evidenceDocumentId: documentId, journalEntryId: journal.id, openItemId: commercial.openItem?.id, invoice, reverseCharge: structuredFacts?.reverseCharge ?? false, recipientAssessedVat: structuredFacts?.recipientAssessedVat ?? false, ...(euCrossBorder ? { commandFingerprint, supplyClassification, supplyDate: structuredData.supplyDate, vatTaxPoint: taxPointText, deliveryCountryCode: structuredData.deliveryCountryCode, tenantBuyerVatId: normalizeVatId(structuredData.buyer.vatId), supplierVatId } : supplyClassification ? { supplyClassification } : {}), vatRuleIds: vatDetails.map(item => item.detail.ruleId) } })
    return commercial
  })
  try { return await run() }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
      const winner = await prisma.journalEntry.findUnique({ where: { externalKey } })
      if (winner) {
        const commercial = await prisma.commercialDocument.findFirst({ where: { ownerId, postingJournalEntryId: winner.id }, include: includePosting })
        if (commercial) {
          const ruleIds = commercial.postingJournalEntry?.lines.flatMap(line => line.vatPosting?.ruleId ? [line.vatPosting.ruleId] : []) ?? []
          if (ruleIds.some(isCrossBorderRecipientAssessedRule)) await requireMatchingEuRecipientAssessedReplay(prisma, ownerId, commercial.id, commandFingerprint)
          return commercial
        }
      }
    }
    throw error
  }
}

function isRecipientAssessedVat(ruleId: StructuredIncomingVatGroup['ruleId']) { return ruleId === 'DE_13B' || ruleId === 'EU_13B_SERVICE_RECIPIENT' || ruleId === 'EU_ACQUISITION' }
function isCrossBorderRecipientAssessedRule(ruleId: string) { return ruleId === 'EU_13B_SERVICE_RECIPIENT' || ruleId === 'EU_ACQUISITION' }
function normalizeVatId(value: unknown) { return typeof value === 'string' ? value.normalize('NFKC').replaceAll(/[^A-Za-z0-9]/g, '').toUpperCase() : '' }
function incomingPostingCommandFingerprint(input: { expenseAccountId: string; dueDate: string; reason: string; assessmentRateBasisPoints?: number; supplyClassification?: string }) { return createHash('sha256').update(JSON.stringify([input.expenseAccountId, input.dueDate, input.reason, input.supplyClassification ?? null, input.assessmentRateBasisPoints ?? null])).digest('hex') }
async function requireMatchingEuRecipientAssessedReplay(client: Pick<typeof prisma, 'auditEvent'>, ownerId: string, commercialDocumentId: string, fingerprint: string) {
  const audit = await client.auditEvent.findFirst({ where: { ownerId, objectId: commercialDocumentId, action: 'INCOMING_INVOICE_POSTED' }, orderBy: { occurredAt: 'desc' }, select: { semanticDelta: true } })
  let stored: unknown
  try { stored = audit ? (JSON.parse(audit.semanticDelta) as { after?: { commandFingerprint?: unknown } }).after?.commandFingerprint : undefined } catch { stored = undefined }
  if (stored !== fingerprint) throw new IncomingInvoicePostingError('The idempotent EU recipient-assessed posting requires an exact replay of expense account, due date, reason, supply classification, and 19% assessment.', 409)
}
