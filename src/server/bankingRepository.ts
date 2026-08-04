import 'server-only'

import { createHash, randomUUID } from 'node:crypto'
import { BankStatementValidationError, parseCamt053 } from '@/core/banking'
import { appendAuditEvent } from '@/server/compliance/auditPersistence'
import { prisma } from '@/server/persistence/client'
import type { Prisma } from '@/generated/prisma/client'

export class BankingError extends Error {}

export async function createBankAccount(ownerId: string, actorId: string, input: { name: string; iban: string; ledgerAccountId: string }) {
  const name = required(input.name, 'Bank account name')
  const iban = normalizeGermanIban(input.iban)
  return prisma.$transaction(async transaction => {
    const ledger = await transaction.ledgerAccount.findFirst({ where: { ownerId, id: input.ledgerAccountId, active: true, category: 'ASSET' } })
    if (!ledger) throw new BankingError('The active bank ledger account does not belong to this tenant.')
    const created = await transaction.bankAccount.create({ data: { ownerId, name, iban, currency: 'EUR', ledgerAccountId: ledger.id } })
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'BANK_ACCOUNT_CREATED', reason: 'Authenticated bank account setup', objectType: 'BankAccount', objectId: created.id, after: { name, iban, ledgerAccountId: ledger.id, currency: 'EUR' } })
    return created
  })
}

export function listBankAccounts(ownerId: string) {
  return prisma.bankAccount.findMany({ where: { ownerId, active: true }, include: { ledgerAccount: true }, orderBy: { name: 'asc' } })
}

export async function importCamtStatement(ownerId: string, actorId: string, bankAccountId: string, content: Uint8Array) {
  const parsed = parseCamt053(content)
  const contentHash = createHash('sha256').update(content).digest('hex')
  return prisma.$transaction(async transaction => {
    const account = await transaction.bankAccount.findFirst({ where: { ownerId, id: bankAccountId, active: true } })
    if (!account) throw new BankingError('The active bank account does not belong to this tenant.')
    if (account.iban !== parsed.iban || account.currency !== parsed.currency) throw new BankingError('The CAMT account identity does not match the selected bank account.')
    await transaction.bankAccount.updateMany({ where: { ownerId, id: account.id }, data: { updatedAt: new Date() } })
    const existingStatement = await transaction.bankStatement.findFirst({ where: { ownerId, bankAccountId, OR: [{ externalStatementId: parsed.externalStatementId }, { contentHash }] } })
    if (existingStatement) {
      if (existingStatement.contentHash !== contentHash || existingStatement.externalStatementId !== parsed.externalStatementId) throw new BankingError('The CAMT statement identity was already imported with different original content.')
      return { statement: existingStatement, imported: 0, skipped: parsed.transactions.length }
    }
    const existing = await transaction.bankTransaction.findMany({ where: { ownerId, bankAccountId, externalKey: { in: parsed.transactions.map(item => item.externalKey) } } })
    const byKey = new Map(existing.map(item => [item.externalKey, item]))
    for (const transaction of parsed.transactions) if (byKey.get(transaction.externalKey)?.factHash !== undefined && byKey.get(transaction.externalKey)!.factHash !== transaction.factHash) throw new BankingError('A bank transaction identity was already imported with different facts.')
    const statement = await transaction.bankStatement.create({ data: {
      id: randomUUID(), ownerId, bankAccountId, externalStatementId: parsed.externalStatementId, contentHash, originalXml: Buffer.from(content),
      periodStart: date(parsed.periodStart), periodEnd: date(parsed.periodEnd), openingBalanceCents: parsed.openingBalanceCents, closingBalanceCents: parsed.closingBalanceCents, importedBy: actorId,
    } })
    const pending = parsed.transactions.filter(item => !byKey.has(item.externalKey))
    if (pending.length) await transaction.bankTransaction.createMany({ data: pending.map(item => ({
      id: randomUUID(), ownerId, bankAccountId, statementId: statement.id, externalKey: item.externalKey, factHash: item.factHash, amountCents: item.amountCents,
      bookingDate: date(item.bookingDate), valueDate: item.valueDate ? date(item.valueDate) : null, bankReference: item.bankReference ?? null,
      counterpartyName: item.counterpartyName ?? null, counterpartyIban: item.counterpartyIban ?? null, remittance: item.remittance ?? null, rawData: item.rawData,
    })) })
    const result = { statement, imported: pending.length, skipped: parsed.transactions.length - pending.length }
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'CAMT_STATEMENT_IMPORTED', reason: 'Authenticated CAMT.053 bank statement import', objectType: 'BankStatement', objectId: statement.id, after: { bankAccountId, externalStatementId: parsed.externalStatementId, contentHash, imported: result.imported, skipped: result.skipped } })
    return result
  })
}

export async function listBankTransactionsWithSuggestions(ownerId: string) {
  const [transactions, openItems] = await Promise.all([
    prisma.bankTransaction.findMany({ where: { ownerId }, include: { bankAccount: true, matches: { include: { reversedBy: true, settlement: { include: { allocations: { where: { kind: 'APPLY' }, include: { reversedBy: true, openItem: { include: { commercialDocument: true } } } } } } }, orderBy: { createdAt: 'asc' } } }, orderBy: [{ bookingDate: 'desc' }, { createdAt: 'desc' }] }),
    prisma.openItem.findMany({ where: { ownerId, status: { in: ['OPEN', 'PARTIAL'] }, commercialDocument: { kind: 'INVOICE' } }, include: { commercialDocument: { include: { businessPartner: true } } } }),
  ])
  return Promise.all(transactions.map(async transaction => {
    const active = transaction.matches.find(match => match.kind === 'APPLY' && match.reversedBy.length === 0)
    const wasReversed = transaction.matches.some(match => match.kind === 'REVERSAL')
    const expectedDirection = transaction.amountCents > 0 ? 'RECEIVABLE' : 'PAYABLE'
    const amount = Math.abs(transaction.amountCents)
    const reference = normalizeReference(transaction.remittance ?? '')
    const matchingItems = active ? [] : openItems.filter(item => item.currency === transaction.currency && item.commercialDocument.direction === expectedDirection && Boolean(item.commercialDocument.documentNumber) && reference.includes(normalizeReference(item.commercialDocument.documentNumber!)))
    const partnerIds = new Set(matchingItems.map(item => item.commercialDocument.businessPartnerId))
    let unassigned = amount
    const suggestions = partnerIds.size !== 1 ? [] : matchingItems.sort((left, right) => left.commercialDocument.documentNumber!.localeCompare(right.commercialDocument.documentNumber!, 'de-DE')).flatMap(item => {
      const remaining = item.originalAmountCents - item.allocatedAmountCents
      const suggested = Math.min(unassigned, remaining)
      if (suggested <= 0) return []
      unassigned -= suggested
      return [{
      openItemId: item.id, documentNumber: item.commercialDocument.documentNumber!, partnerName: item.commercialDocument.businessPartner.name,
      amountCents: suggested, currency: item.currency, reason: suggested === remaining ? 'Full open remainder, direction, currency, partner, and document number match' : 'Partial amount within the open remainder, with matching direction, currency, partner, and document number',
    }]
    })
    const activeSettlement = active?.settlement ?? null
    const activeAllocations = activeSettlement?.allocations.filter(allocation => allocation.reversedBy.length === 0) ?? []
    return { ...transaction, reviewState: active ? 'MATCHED' as const : wasReversed ? 'REVERSED' as const : 'UNMATCHED' as const, activeMatch: active ? { id: active.id, journalEntryId: active.journalEntryId, openItemId: active.openItemId, amountCents: active.amountCents, allocations: activeAllocations.map(allocation => ({ openItemId: allocation.openItemId, documentNumber: allocation.openItem.commercialDocument.documentNumber, amountCents: allocation.amountCents })), creditCents: activeSettlement!.amountCents - activeSettlement!.allocatedAmountCents } : null, suggestions, suggestedCreditCents: active ? 0 : unassigned }
  }))
}

type BankAllocationInput = { openItemId: string; amountCents: number }

export async function confirmBankTransactionMatch(ownerId: string, actorId: string, bankTransactionId: string, requestKey: string, input: { openItemId?: string; allocations?: BankAllocationInput[]; reason: string }) {
  validateRequest(requestKey, input.reason)
  return prisma.$transaction(async transaction => {
    const bankTransaction = await transaction.bankTransaction.findFirst({ where: { ownerId, id: bankTransactionId }, include: { bankAccount: true, matches: { include: { reversedBy: true } } } })
    if (!bankTransaction) throw new BankingError('The bank transaction does not belong to this tenant.')
    const amountCents = Math.abs(bankTransaction.amountCents)
    const requested = input.allocations ?? (input.openItemId ? [{ openItemId: input.openItemId, amountCents }] : [])
    if (!requested.length || requested.some(item => !item.openItemId || !Number.isSafeInteger(item.amountCents) || item.amountCents <= 0) || new Set(requested.map(item => item.openItemId)).size !== requested.length) throw new BankingError('At least one unique open-item allocation with positive integer cents is required.')
    const allocationsInput = [...requested].sort((left, right) => left.openItemId.localeCompare(right.openItemId))
    const allocatedTotal = allocationsInput.reduce((sum, item) => { const result = sum + item.amountCents; if (!Number.isSafeInteger(result)) throw new BankingError('The allocation total exceeds the safe cent range.'); return result }, 0)
    if (allocatedTotal > amountCents) throw new BankingError('The allocations exceed the bank transaction amount.')
    const requestHash = hashRequest({ bankTransactionId, allocations: allocationsInput })
    const existing = await transaction.bankTransactionMatch.findUnique({ where: { ownerId_requestKey: { ownerId, requestKey } }, include: matchInclude })
    if (existing) { if (existing.requestHash !== requestHash) throw new BankingError('The bank match request key was already used with different facts.'); return existing }
    await transaction.bankAccount.updateMany({ where: { ownerId, id: bankTransaction.bankAccountId }, data: { updatedAt: new Date() } })
    if (bankTransaction.matches.some(match => match.kind === 'APPLY' && match.reversedBy.length === 0)) throw new BankingError('The bank transaction already has an active match.')
    const openItems = await transaction.openItem.findMany({ where: { ownerId, id: { in: allocationsInput.map(item => item.openItemId) }, status: { in: ['OPEN', 'PARTIAL'] } }, include: { commercialDocument: { include: { businessPartner: true } } } })
    if (openItems.length !== allocationsInput.length) throw new BankingError('An open item does not belong to this tenant or is already settled.')
    const byId = new Map(openItems.map(item => [item.id, item])); const direction = bankTransaction.amountCents > 0 ? 'RECEIVABLE' : 'PAYABLE'
    const partnerIds = new Set(openItems.map(item => item.commercialDocument.businessPartnerId))
    for (const allocation of allocationsInput) { const item = byId.get(allocation.openItemId)!; const remainingCents = item.originalAmountCents - item.allocatedAmountCents; if (item.currency !== 'EUR' || amountCents <= 0 || allocation.amountCents > remainingCents || item.commercialDocument.kind !== 'INVOICE' || item.commercialDocument.direction !== direction) throw new BankingError('A selected open item does not match the bank currency and payment direction, or its allocation exceeds the open remainder.') }
    if (partnerIds.size !== 1) throw new BankingError('One bank transaction can only be allocated to open items for the same business partner.')
    const primary = byId.get(allocationsInput[0].openItemId)!
    const period = await uniqueOpenPeriod(transaction, ownerId, bankTransaction.bookingDate)
    const profile = await transaction.ledgerProfile.findUniqueOrThrow({ where: { ownerId } }); const scale = 10 ** ((profile.accountLength ?? 4) - 4)
    const controlNumber = (direction === 'RECEIVABLE' ? profile.chart === 'SKR04' ? 1200 : 1400 : profile.chart === 'SKR04' ? 3300 : 1600) * scale
    const control = await transaction.ledgerAccount.findFirst({ where: { ownerId, number: controlNumber, active: true } })
    const bank = await transaction.ledgerAccount.findFirst({ where: { ownerId, id: bankTransaction.bankAccount.ledgerAccountId, active: true, category: 'ASSET' } })
    if (!bank || !control) throw new BankingError('The active bank and receivable/payable control accounts must be configured before matching.')
    const journalId = randomUUID(); const externalKey = `BANK:${createHash('sha256').update(`${ownerId}:${requestKey}`).digest('hex')}`; const documentNumber = `BANK-${bankTransaction.bookingDate.toISOString().slice(0, 10).replaceAll('-', '')}-${externalKey.slice(-8)}`
    const last = await transaction.journalEntry.findFirst({ where: { fiscalYearId: period.id }, orderBy: { sequenceNumber: 'desc' }, select: { sequenceNumber: true } })
    const receipt = bankTransaction.amountCents > 0
    const documentNumbers = openItems.map(item => item.commercialDocument.documentNumber).sort().join(', ')
    const journal = await transaction.journalEntry.create({ data: { id: journalId, ownerId, fiscalYearId: period.id, sequenceNumber: (last?.sequenceNumber ?? 0) + 1, bookingDate: bankTransaction.bookingDate, documentNumber, description: `Bank payment ${documentNumbers}`, source: 'BANK', externalKey, lines: { create: receipt ? [{ accountId: bank.id, debitCents: amountCents }, { accountId: control.id, creditCents: amountCents }] : [{ accountId: control.id, debitCents: amountCents }, { accountId: bank.id, creditCents: amountCents }] } } })
    const settlement = await transaction.paymentSettlement.create({ data: { ownerId, businessPartnerId: primary.commercialDocument.businessPartnerId, journalEntryId: journal.id, direction: receipt ? 'RECEIPT' : 'DISBURSEMENT', currency: 'EUR', amountCents, occurredOn: bankTransaction.bookingDate, createdBy: actorId } })
    const createdAllocations = []
    for (const [index, requestedAllocation] of allocationsInput.entries()) createdAllocations.push(await transaction.settlementAllocation.create({ data: { ownerId, openItemId: requestedAllocation.openItemId, settlementId: settlement.id, journalEntryId: journal.id, kind: 'APPLY', amountCents: requestedAllocation.amountCents, requestKey: childRequestKey(requestKey, 'allocation', index), requestHash, effectiveDate: bankTransaction.bookingDate, createdBy: actorId } }))
    for (const allocation of createdAllocations) await synchronizeDerivedSettlementBalances(transaction, ownerId, allocation.openItemId, settlement.id)
    const allocation = createdAllocations[0]
    const match = await transaction.bankTransactionMatch.create({ data: { ownerId, bankTransactionId, openItemId: allocation.openItemId, settlementId: settlement.id, allocationId: allocation.id, journalEntryId: journal.id, kind: 'APPLY', amountCents, requestKey, requestHash, effectiveDate: bankTransaction.bookingDate, createdBy: actorId }, include: matchInclude })
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'BANK_TRANSACTION_MATCHED', reason: input.reason, objectType: 'BankTransactionMatch', objectId: match.id, after: { bankTransactionId, allocations: allocationsInput, journalEntryId: journal.id, settlementId: settlement.id, amountCents, creditCents: amountCents - allocatedTotal } })
    return match
  })
}

export async function reverseBankTransactionMatch(ownerId: string, actorId: string, matchId: string, requestKey: string, input: { effectiveDate: string; reason: string }) {
  validateRequest(requestKey, input.reason); const effectiveDate = validDate(input.effectiveDate); const requestHash = hashRequest({ matchId, effectiveDate: input.effectiveDate })
  return prisma.$transaction(async transaction => {
    const existing = await transaction.bankTransactionMatch.findUnique({ where: { ownerId_requestKey: { ownerId, requestKey } }, include: matchInclude })
    if (existing) { if (existing.requestHash !== requestHash) throw new BankingError('The bank reversal request key was already used with different facts.'); return existing }
    const original = await transaction.bankTransactionMatch.findFirst({ where: { ownerId, id: matchId, kind: 'APPLY' }, include: { reversedBy: true, bankTransaction: { include: { bankAccount: true } }, journalEntry: { include: { lines: true } }, settlement: { include: { allocations: { where: { kind: 'APPLY' }, include: { reversedBy: true } } } }, allocation: true } })
    if (!original) throw new BankingError('The bank match does not belong to this tenant.')
    await transaction.bankAccount.updateMany({ where: { ownerId, id: original.bankTransaction.bankAccountId }, data: { updatedAt: new Date() } })
    if (original.reversedBy.length) throw new BankingError('The bank match has already been reversed.')
    const period = await uniqueOpenPeriod(transaction, ownerId, effectiveDate); const last = await transaction.journalEntry.findFirst({ where: { fiscalYearId: period.id }, orderBy: { sequenceNumber: 'desc' }, select: { sequenceNumber: true } })
    const journalId = randomUUID(); const externalKey = `BANKREV:${createHash('sha256').update(`${ownerId}:${requestKey}`).digest('hex')}`; const documentNumber = `BREV-${input.effectiveDate.replaceAll('-', '')}-${externalKey.slice(-8)}`
    const journal = await transaction.journalEntry.create({ data: { id: journalId, ownerId, fiscalYearId: period.id, sequenceNumber: (last?.sequenceNumber ?? 0) + 1, bookingDate: effectiveDate, documentNumber, description: `Reversal of ${original.journalEntry.documentNumber}`, source: 'BANK_REVERSAL', externalKey, reversalOfId: original.journalEntryId, lines: { create: original.journalEntry.lines.map(line => ({ accountId: line.accountId, debitCents: line.creditCents, creditCents: line.debitCents })) } } })
    const activeAllocations = original.settlement.allocations.filter(allocation => allocation.reversedBy.length === 0).sort((left, right) => left.id === original.allocationId ? -1 : right.id === original.allocationId ? 1 : left.id.localeCompare(right.id))
    if (!activeAllocations.length || activeAllocations[0].id !== original.allocationId) throw new BankingError('The bank reconciliation allocation history is incomplete.')
    const reversalAllocations = []
    for (const [index, prior] of activeAllocations.entries()) reversalAllocations.push(await transaction.settlementAllocation.create({ data: { ownerId, openItemId: prior.openItemId, settlementId: original.settlementId, journalEntryId: journal.id, kind: 'REVERSAL', amountCents: -prior.amountCents, requestKey: childRequestKey(requestKey, 'reversal', index), requestHash, reversesAllocationId: prior.id, effectiveDate, createdBy: actorId } }))
    for (const allocation of reversalAllocations) await synchronizeDerivedSettlementBalances(transaction, ownerId, allocation.openItemId, original.settlementId)
    const allocation = reversalAllocations[0]
    const reversal = await transaction.bankTransactionMatch.create({ data: { ownerId, bankTransactionId: original.bankTransactionId, openItemId: original.openItemId, settlementId: original.settlementId, allocationId: allocation.id, journalEntryId: journal.id, kind: 'REVERSAL', amountCents: -original.amountCents, requestKey, requestHash, reversesMatchId: original.id, effectiveDate, createdBy: actorId }, include: matchInclude })
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'BANK_TRANSACTION_MATCH_REVERSED', reason: input.reason, objectType: 'BankTransactionMatch', objectId: reversal.id, after: { reversesMatchId: original.id, journalEntryId: journal.id, allocationId: allocation.id, amountCents: reversal.amountCents } })
    return reversal
  })
}

const matchInclude = { journalEntry: { include: { lines: { include: { account: true } } } }, settlement: { include: { allocations: { include: { reversedBy: true, openItem: { include: { commercialDocument: true } } } } } }, allocation: true } as const
async function uniqueOpenPeriod(transaction: Prisma.TransactionClient, ownerId: string, instant: Date) { const periods = await transaction.fiscalYear.findMany({ where: { ownerId, startsAt: { lte: instant }, endsAt: { gte: instant } } }); if (periods.length !== 1 || periods[0].status !== 'OPEN') throw new BankingError('The payment date requires exactly one open fiscal period.'); const locked = await transaction.fiscalYear.updateMany({ where: { ownerId, id: periods[0].id, status: 'OPEN' }, data: { updatedAt: new Date() } }); if (locked.count !== 1) throw new BankingError('The fiscal period changed while matching.'); return periods[0] }
async function synchronizeDerivedSettlementBalances(transaction: Prisma.TransactionClient, ownerId: string, openItemId: string, settlementId: string) {
  await transaction.$executeRaw`UPDATE OpenItem SET allocatedAmountCents=(SELECT COALESCE(SUM(amountCents),0) FROM SettlementAllocation WHERE ownerId=${ownerId} AND openItemId=${openItemId}), status=CASE WHEN (SELECT COALESCE(SUM(amountCents),0) FROM SettlementAllocation WHERE ownerId=${ownerId} AND openItemId=${openItemId})=0 THEN 'OPEN' WHEN (SELECT COALESCE(SUM(amountCents),0) FROM SettlementAllocation WHERE ownerId=${ownerId} AND openItemId=${openItemId})=originalAmountCents THEN 'SETTLED' ELSE 'PARTIAL' END, version=version+1, updatedAt=CURRENT_TIMESTAMP WHERE ownerId=${ownerId} AND id=${openItemId} AND allocatedAmountCents!=(SELECT COALESCE(SUM(amountCents),0) FROM SettlementAllocation WHERE ownerId=${ownerId} AND openItemId=${openItemId})`
  await transaction.$executeRaw`UPDATE PaymentSettlement SET allocatedAmountCents=(SELECT COALESCE(SUM(amountCents),0) FROM SettlementAllocation WHERE ownerId=${ownerId} AND settlementId=${settlementId}), status=CASE WHEN (SELECT COALESCE(SUM(amountCents),0) FROM SettlementAllocation WHERE ownerId=${ownerId} AND settlementId=${settlementId})=0 THEN 'UNALLOCATED' WHEN (SELECT COALESCE(SUM(amountCents),0) FROM SettlementAllocation WHERE ownerId=${ownerId} AND settlementId=${settlementId})=amountCents THEN 'ALLOCATED' ELSE 'PARTIAL' END, version=version+1, updatedAt=CURRENT_TIMESTAMP WHERE ownerId=${ownerId} AND id=${settlementId} AND allocatedAmountCents!=(SELECT COALESCE(SUM(amountCents),0) FROM SettlementAllocation WHERE ownerId=${ownerId} AND settlementId=${settlementId})`
}
function validateRequest(key: string, reason: string) { if (!/^[A-Za-z0-9._:-]{16,100}$/.test(key)) throw new BankingError('The idempotency key must contain 16-100 safe characters.'); required(reason, 'A documented reason') }
function hashRequest(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function childRequestKey(key: string, kind: 'allocation' | 'reversal', index: number) { return `${key.slice(0, 86)}:${kind === 'allocation' ? 'a' : 'r'}:${index}` }
function validDate(value: string) { const result = new Date(`${value}T12:00:00.000Z`); if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(result.valueOf()) || result.toISOString().slice(0, 10) !== value) throw new BankingError('The effective date must be an ISO calendar date.'); return result }

function normalizeReference(value: string) { return value.normalize('NFKC').toLocaleUpperCase('de-DE').replace(/[^A-Z0-9]/g, '') }
function required(value: string, label: string) { if (!value?.trim()) throw new BankingError(`${label} is required.`); return value.trim() }
function date(value: string) { return new Date(`${value}T12:00:00.000Z`) }
function normalizeGermanIban(value: string) {
  const iban = value.replace(/\s/g, '').toUpperCase()
  if (!/^DE\d{20}$/.test(iban)) throw new BankingError('A valid German IBAN is required.')
  const rearranged = `${iban.slice(4)}${iban.slice(0, 4)}`.replace(/[A-Z]/g, character => String(character.charCodeAt(0) - 55))
  let remainder = 0; for (const digit of rearranged) remainder = (remainder * 10 + Number(digit)) % 97
  if (remainder !== 1) throw new BankingError('A valid German IBAN is required.')
  return iban
}

export { BankStatementValidationError }
