import { Database, PersistentStorage } from '@sanjo/database'
import { Address } from 'accounting-core/Address.js'
import { Account } from 'accounting-core/authentication/Account.js'
import { BookingRecord } from 'accounting-core/BookingRecord.js'
import cors from 'cors'
import express from 'express'
import pick from 'lodash/pick.js'
import { Accounts } from './Accounts.js'

const storage = new PersistentStorage('database')
const database = new Database(storage)
const accounts = new Accounts(await database.createCollection('accounts'))
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

const port = process.env.PORT || 80
app.listen(port, () => {
  console.log(`❤ Listening on port ${ port }...`)
})
