import express from 'express'
import { BookingRecord } from 'accounting-core/BookingRecord.js'
import { Database, PersistentStorage } from '@sanjo/database'
import cors from 'cors'

const storage = new PersistentStorage('database')
const database = new Database(storage)
const bookingRecords = await database.createCollection('bookingRecords')

const app = express()
app.use(cors())
app.use(express.json())

app.post('/booking-records', async function (request, response) {
  console.log(request.body)
  const { date, debitSide, creditSide } = request.body
  const bookingRecord = new BookingRecord(date, debitSide, creditSide)
  await bookingRecords.insert(bookingRecord)
  response.json({
    success: true
  })
  response.end()
})

const port = process.env.PORT || 80
app.listen(port, () => {
  console.log(`❤ Listening on port ${ port }...`)
})
