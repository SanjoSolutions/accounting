import 'server-only'

import { Database, PersistentStorage } from '@sanjo/database'
import { randomUUID } from 'node:crypto'
import { BookingRecord } from '@/core/BookingRecord'
import { Document } from '@/core/Document'
import type { Invoice } from '@/core/Invoice'
import { Tax } from '@/core/Tax'
import { TaxAmount } from '@/core/TaxAmount'
import { Account } from '@/core/authentication/Account'
import fixture from './dataFixtures/results_11048337544652359545_0_Invoice_Example_English-0.json'
import { Accounts } from './Accounts'
import { Documents } from './Documents'

interface Context {
  accounts: Accounts
  documents: Documents
  bookingRecords: Awaited<ReturnType<Database['createCollection']>>
}

let contextPromise: Promise<Context> | undefined

async function getContext(): Promise<Context> {
  contextPromise ??= createContext()
  return contextPromise
}

async function createContext(): Promise<Context> {
  const database = new Database(new PersistentStorage('database'))

  return {
    accounts: new Accounts(await database.createCollection('accounts')),
    documents: new Documents(await database.createCollection('documents')),
    bookingRecords: await database.createCollection('bookingRecords'),
  }
}

export async function createBookingRecord(data: any): Promise<void> {
  const { bookingRecords } = await getContext()
  const { date, debitSide, creditSide } = data
  await bookingRecords.insert(new BookingRecord(date, debitSide, creditSide))
}

export async function getSettings(accountId: string): Promise<Account> {
  const { accounts } = await getContext()
  let account = await accounts.findOne(accountId)

  if (!account) {
    account = new Account(accountId)
    await accounts.save(account)
  }

  return account
}

export async function updateSettings(data: any): Promise<void> {
  const { accounts } = await getContext()
  const account = await getSettings('1')
  const invoiceIssuer = data.invoiceIssuer ?? {}

  Object.assign(account.invoiceIssuer, {
    name: invoiceIssuer.name,
    streetAndHouseNumber: invoiceIssuer.streetAndHouseNumber,
    zipCode: invoiceIssuer.zipCode,
    city: invoiceIssuer.city,
    country: invoiceIssuer.country,
  })
  await accounts.save(account)
}

export async function createDocument(data: any): Promise<Document> {
  const { documents } = await getContext()
  const document = new Document(randomUUID(), data.url)
  document.gsURL = data.gsURL
  await documents.save(document)
  return document
}

export async function requestDocumentParsing(documentId: string): Promise<Invoice | null> {
  const { documents } = await getContext()
  const document = await documents.findOne(documentId)

  if (!document?.gsURL) {
    return null
  }

  const invoice = document as Invoice
  invoice.netAmount = getMoneyValue(fixture, 'net_amount')!
  invoice.tax = new TaxAmount(
    getTaxAmount(fixture)!,
    new Tax('19% VAT', 0.19),
  )
  invoice.total = getMoneyValue(fixture, 'total_amount')!
  await documents.save(invoice)
  return invoice
}

function getTaxAmount(data: any): number | null {
  const tax = getObjectWithType(data.entities, 'vat')
  const taxAmount = tax && getObjectWithType(tax.properties, 'vat/tax_amount')
  return taxAmount ? normalizedMoneyValue(taxAmount) : null
}

function getMoneyValue(data: any, type: string): number | null {
  const entity = getObjectWithType(data.entities, type)
  return entity ? normalizedMoneyValue(entity) : null
}

function getObjectWithType(items: any[], type: string): any | null {
  return items.find((item: any) => item.type === type) ?? null
}

function normalizedMoneyValue(entity: any): number {
  const { units, nanos = 0 } = entity.normalizedValue.moneyValue
  return Number(units) + Number(nanos) / 1_000_000_000
}
