import type { File } from '@google-cloud/storage'
import { Database, PersistentStorage } from '@sanjo/database'
import { readJSON } from '@sanjo/read-json'
import { BookingRecord } from 'accounting-core/BookingRecord.js'
import { Document } from 'accounting-core/Document.js'
import type { Invoice } from 'accounting-core/Invoice.js'
import { Tax } from 'accounting-core/Tax.js'
import { TaxAmount } from 'accounting-core/TaxAmount.js'
import cors from 'cors'
import express from 'express'
import pick from 'lodash/pick.js'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { v4 as generateUUID } from 'uuid'
import { Accounts } from './Accounts.js'
import { Documents } from './Documents.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const storage = new PersistentStorage('database')
const database = new Database(storage)
const accounts = new Accounts(await database.createCollection('accounts'))
const documents = new Documents(await database.createCollection('documents'))
const bookingRecords = await database.createCollection('bookingRecords')

const app = express()
app.use(cors())
app.use(express.json())

app.post('/booking-records', async function (request, response) {
  const { date, debitSide, creditSide } = request.body
  const bookingRecord = new BookingRecord(date, debitSide, creditSide)
  await bookingRecords.insert(bookingRecord)
  response.json({
    success: true,
  })
  response.end()
})

app.get('/settings/:accountId', async function (request, response) {
  const accountId = request.params.accountId
  const account = await accounts.findOne(accountId)
  response.json({
    success: true,
    data: account,
  })
  response.end()
})

app.put('/settings', async function (request, response) {
  console.log(request.body)
  const accountId = '1'
  const account = (await accounts.findOne(accountId))!
  Object.assign(
    account.invoiceIssuer,
    pick(request.body.invoiceIssuer, ['name', 'streetAndHouseNumber', 'zipCode', 'city', 'country']),
  )
  await accounts.save(account)
  response.json({
    success: true,
  })
  response.end()
})

app.post('/documents', async function (request, response) {
  const { url, gsURL } = request.body
  const document = new Document(generateUUID(), url)
  document.gsURL = gsURL
  await documents.save(document)
  response.json({
    success: true,
    data: document,
  })
  response.end()
})

app.post('/documents/:id/parsing-requests', async function (request, response) {
  const documentId = request.params.id
  const document = await documents.findOne(documentId)
  if (document && document.gsURL) {
    // const gcsOutputUri = 'gs://accounting-339615.appspot.com'
    // const gcsOutputUriPrefix = 'output'
    // await parseInvoice(document.gsURL, `${ gcsOutputUri }/${ gcsOutputUriPrefix }/`)
    // const storage = new Storage()
    // const query = {
    //   prefix: gcsOutputUriPrefix,
    // }
    // const [files] = await storage.bucket(gcsOutputUri).getFiles(query)
    // const file = first(files)!
    // const data = await downloadResult(file)
    const data = await downloadResultWithFixture()
    const invoice = document as Invoice
    invoice.netAmount = getNetAmount(data)!
    invoice.tax = new TaxAmount(
      getTaxAmount(data)!,
      new Tax('19% VAT', 0.19),
    )
    invoice.total = getTotalAmount(data)!
    await documents.save(invoice)
    response.json({
      success: true,
      data: invoice,
    })
  } else {
    response.json({
      success: false,
    })
  }

  response.end()
})

async function downloadResult(file: File): Promise<any> {
  const buffer = await file.download()
  return JSON.parse(buffer.toString())
}

async function downloadResultWithFixture(): Promise<any> {
  return await readJSON(resolve(
    __dirname,
    'dataFixtures/results_11048337544652359545_0_Invoice_Example_English-0.json',
  ))
}

function getNetAmount(data: any): number | null {
  const entity = getEntity(data, 'net_amount')
  return entity ? getMoneyValue(entity) : null
}

function getTaxAmount(data: any): number | null {
  const tax = getEntity(data, 'vat')
  if (tax) {
    const taxAmount = getProperty(tax, 'vat/tax_amount')
    if (taxAmount) {
      return getMoneyValue(taxAmount)
    }
  }
  return null
}

function getTotalAmount(data: any): number | null {
  const entity = getEntity(data, 'total_amount')
  return entity ? getMoneyValue(entity) : null
}

function getEntity(data: any, type: string): any | null {
  return getObjectWithType(data.entities, type)
}

function getProperty(entity: any, type: string): any | null {
  return getObjectWithType(entity.properties, type)
}

function getObjectWithType(array: any[], type: string): any | null {
  return array.find((object: any) => object.type === type) ?? null
}

function getMoneyValue(entity: any): number {
  // TODO: Consider currency. (for converting currency, booking in currency...)
  const moneyValue = entity.normalizedValue.moneyValue
  let moneyString = moneyValue.units
  if (moneyValue.nanos) {
    moneyString += '.' + moneyValue.nanos
  }
  const value = Number(moneyString)
  return value
}

const port = process.env.PORT || 80
app.listen(port, () => {
  console.log(`❤ Listening on port ${ port }...`)
})
