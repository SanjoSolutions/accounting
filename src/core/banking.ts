import { createHash } from 'node:crypto'
import { SaxesParser } from 'saxes'

export class BankStatementValidationError extends Error {}

export interface ParsedBankTransaction {
  externalKey: string
  factHash: string
  amountCents: number
  currency: 'EUR'
  bookingDate: string
  valueDate?: string
  bankReference?: string
  counterpartyName?: string
  counterpartyIban?: string
  remittance?: string
  rawData: string
}

export interface ParsedBankStatement {
  externalStatementId: string
  iban: string
  currency: 'EUR'
  periodStart: string
  periodEnd: string
  openingBalanceCents: number
  closingBalanceCents: number
  transactions: ParsedBankTransaction[]
}

type XmlNode = { local: string; uri: string; text: string; attributes: Record<string, string>; children: XmlNode[] }
const CAMT_NAMESPACE = 'urn:iso:std:iso:20022:tech:xsd:camt.053.'
const MAX_XML_BYTES = 2 * 1024 * 1024
const MAX_NODES = 50_000
const MAX_TRANSACTIONS = 5_000

export function parseCamt053(xml: Uint8Array | string): ParsedBankStatement {
  const source = typeof xml === 'string' ? xml : Buffer.from(xml).toString('utf8')
  if (!source.trim()) throw new BankStatementValidationError('The CAMT statement is empty.')
  if (Buffer.byteLength(source, 'utf8') > MAX_XML_BYTES) throw new BankStatementValidationError('The CAMT statement exceeds 2 MiB.')
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new BankStatementValidationError('DTD and entity declarations are not allowed in CAMT statements.')
  const root: XmlNode = { local: '#document', uri: '', text: '', attributes: {}, children: [] }
  const stack = [root]
  let nodes = 0
  try {
    const parser = new SaxesParser({ xmlns: true })
    parser.on('opentag', tag => {
      if (++nodes > MAX_NODES) throw new Error('node limit')
      const attributes = Object.fromEntries(Object.values(tag.attributes).map(attribute => [attribute.local, attribute.value]))
      const node: XmlNode = { local: tag.local, uri: tag.uri, text: '', attributes, children: [] }
      stack[stack.length - 1].children.push(node); stack.push(node)
    })
    parser.on('text', value => { stack[stack.length - 1].text += value })
    parser.on('cdata', value => { stack[stack.length - 1].text += value })
    parser.on('closetag', () => { stack.pop() })
    parser.write(source).close()
  } catch { throw new BankStatementValidationError('The CAMT statement must be bounded, well-formed namespace-aware XML.') }
  const document = one(root, 'Document')
  if (!document.uri.startsWith(CAMT_NAMESPACE)) throw new BankStatementValidationError('Only ISO 20022 camt.053 documents are supported.')
  const statements = descendants(document, 'Stmt')
  if (statements.length !== 1) throw new BankStatementValidationError('A CAMT upload must contain exactly one statement.')
  const statement = statements[0]
  const externalStatementId = requiredText(one(statement, 'Id'), 'statement ID')
  const iban = normalizeIban(requiredText(one(one(one(statement, 'Acct'), 'Id'), 'IBAN'), 'IBAN'))
  const period = one(statement, 'FrToDt')
  const periodStart = isoDate(requiredText(one(period, 'FrDtTm'), 'period start').slice(0, 10), 'period start')
  const periodEnd = isoDate(requiredText(one(period, 'ToDtTm'), 'period end').slice(0, 10), 'period end')
  if (periodEnd < periodStart) throw new BankStatementValidationError('The CAMT period end precedes its start.')
  const balances = children(statement, 'Bal').map(balance => ({
    code: optionalText(descendants(one(balance, 'Tp'), 'Cd')[0]),
    amount: signedAmount(one(balance, 'Amt'), requiredText(one(balance, 'CdtDbtInd'), 'balance debit/credit indicator')),
  }))
  const opening = balances.filter(balance => balance.code === 'OPBD')
  const closing = balances.filter(balance => balance.code === 'CLBD')
  if (opening.length !== 1 || closing.length !== 1) throw new BankStatementValidationError('Exactly one OPBD opening and CLBD closing EUR balance are required.')
  const entries = children(statement, 'Ntry')
  if (entries.length > MAX_TRANSACTIONS) throw new BankStatementValidationError('The CAMT statement exceeds 5,000 transactions.')
  const occurrence = new Map<string, number>()
  const seenExplicit = new Set<string>()
  const transactions = entries.map(entry => {
    const status = optionalText(descendants(one(entry, 'Sts'), 'Cd')[0])
    if (status !== 'BOOK') throw new BankStatementValidationError('Only booked CAMT transactions can be imported.')
    if (optionalText(children(entry, 'RvslInd')[0])?.toLowerCase() === 'true') throw new BankStatementValidationError('CAMT reversal entries require the explicit reversal workflow.')
    const amountCents = signedAmount(one(entry, 'Amt'), requiredText(one(entry, 'CdtDbtInd'), 'transaction debit/credit indicator'))
    if (amountCents === 0) throw new BankStatementValidationError('Zero-value CAMT transactions are not supported.')
    const bookingDate = isoDate(dateChoice(one(entry, 'BookgDt')), 'booking date')
    const valueNode = children(entry, 'ValDt')[0]
    const valueDate = valueNode ? isoDate(dateChoice(valueNode), 'value date') : undefined
    const details = descendants(entry, 'TxDtls')
    if (details.length > 1) throw new BankStatementValidationError('Batched CAMT entries require separate transaction details and are not supported by this review workflow.')
    const detail = details[0] ?? entry
    const refs = children(detail, 'Refs')[0]
    const bankReference = firstText(refs, ['AcctSvcrRef', 'NtryRef', 'TxId']) ?? firstText(entry, ['AcctSvcrRef', 'NtryRef'])
    const parties = children(detail, 'RltdPties')[0]
    const counterpartyName = firstDescendantText(parties, amountCents > 0 ? ['Dbtr'] : ['Cdtr'], 'Nm')
    const counterpartyIban = firstDescendantText(parties, amountCents > 0 ? ['DbtrAcct'] : ['CdtrAcct'], 'IBAN')
    const remittance = optionalText(descendants(detail, 'Ustrd')[0])
    const facts = { amountCents, currency: 'EUR' as const, bookingDate, valueDate, bankReference, counterpartyName, counterpartyIban: counterpartyIban ? normalizeIban(counterpartyIban) : undefined, remittance }
    const factHash = hash(facts)
    let identity: string
    if (bankReference) {
      identity = `REF:${bankReference.normalize('NFKC').trim()}`
      if (seenExplicit.has(identity)) throw new BankStatementValidationError('A bank transaction reference occurs more than once in the statement.')
      seenExplicit.add(identity)
    } else {
      const index = (occurrence.get(factHash) ?? 0) + 1; occurrence.set(factHash, index)
      identity = `FACT:${factHash}:${index}`
    }
    return { ...facts, externalKey: hash(identity), factHash, rawData: JSON.stringify(facts) }
  })
  const movement = transactions.reduce((sum, transaction) => checkedAdd(sum, transaction.amountCents), 0)
  if (checkedAdd(opening[0].amount, movement) !== closing[0].amount) throw new BankStatementValidationError('Opening balance plus booked transactions does not equal the closing balance.')
  return { externalStatementId, iban, currency: 'EUR', periodStart, periodEnd, openingBalanceCents: opening[0].amount, closingBalanceCents: closing[0].amount, transactions }
}

function children(node: XmlNode | undefined, local: string) { return node?.children.filter(child => child.local === local) ?? [] }
function descendants(node: XmlNode | undefined, local: string): XmlNode[] { return node ? node.children.flatMap(child => [...(child.local === local ? [child] : []), ...descendants(child, local)]) : [] }
function one(node: XmlNode | undefined, local: string) { const matches = children(node, local); if (matches.length !== 1) throw new BankStatementValidationError(`Exactly one ${local} element is required.`); return matches[0] }
function requiredText(node: XmlNode | undefined, label: string) { const value = optionalText(node); if (!value) throw new BankStatementValidationError(`The CAMT ${label} is required.`); return value }
function optionalText(node: XmlNode | undefined) { const value = node?.text.normalize('NFKC').trim(); return value || undefined }
function firstText(node: XmlNode | undefined, names: string[]) { for (const name of names) { const value = optionalText(descendants(node, name)[0]); if (value) return value } return undefined }
function firstDescendantText(node: XmlNode | undefined, containers: string[], field: string) { for (const container of containers) { const value = optionalText(descendants(descendants(node, container)[0], field)[0]); if (value) return value } return undefined }
function dateChoice(node: XmlNode) { const values = [...children(node, 'Dt'), ...children(node, 'DtTm')]; if (values.length !== 1) throw new BankStatementValidationError('A CAMT date must contain exactly one date value.'); return requiredText(values[0], 'date').slice(0, 10) }
function isoDate(value: string, label: string) { const date = new Date(`${value}T00:00:00.000Z`); if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) throw new BankStatementValidationError(`The CAMT ${label} must be an ISO calendar date.`); return value }
function normalizeIban(value: string) { const iban = value.replace(/\s/g, '').toUpperCase(); if (!/^DE\d{20}$/.test(iban)) throw new BankStatementValidationError('A German IBAN is required.'); return iban }
function signedAmount(node: XmlNode, indicator: string) { if (node.attributes.Ccy !== 'EUR') throw new BankStatementValidationError('Only EUR CAMT amounts are supported.'); const cents = decimalCents(requiredText(node, 'amount')); if (indicator === 'CRDT') return cents; if (indicator === 'DBIT') return -cents; throw new BankStatementValidationError('CAMT debit/credit indicator must be CRDT or DBIT.') }
function decimalCents(value: string) { const match = /^(0|[1-9]\d*)\.(\d{2})$/.exec(value); if (!match) throw new BankStatementValidationError('CAMT EUR amounts require exactly two decimal places.'); const cents = Number(match[1]) * 100 + Number(match[2]); if (!Number.isSafeInteger(cents)) throw new BankStatementValidationError('The CAMT amount exceeds the safe cent range.'); return cents }
function checkedAdd(sum: number, value: number) { const result = sum + value; if (!Number.isSafeInteger(result)) throw new BankStatementValidationError('CAMT balance arithmetic exceeds the safe cent range.'); return result }
function hash(value: unknown) { return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex') }
