import { Database, PersistentStorage } from '@sanjo/database'
import { BookingRecord } from 'accounting-core/BookingRecord.js'
import { Document } from 'accounting-core/Document.js'
import cors from 'cors'
import express from 'express'
import pick from 'lodash/pick.js'
import { Accounts } from './Accounts.js'
import { Documents } from './Documents.js'
import { v4 as generateUUID } from 'uuid'
import { parseInvoice } from 'accounting-core/documentParsing/parseInvoice.js'

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
    data: document
  })
  response.end()
})

app.post('/documents/:id/parsing-requests', async function (request, response) {
  const documentId = request.params.id
  const document = await documents.findOne(documentId)
  let success
  if (document && document.gsURL) {
    await parseInvoice(document.gsURL, 'gs://accounting-339615.appspot.com/output/')
    success = true
  } else {
    success = false
  }
  response.json({
    success,
  })
  response.end()
})

const port = process.env.PORT || 80
app.listen(port, () => {
  console.log(`❤ Listening on port ${ port }...`)
})
