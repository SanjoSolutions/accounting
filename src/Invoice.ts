import { Address } from './Address'
import type { BookingStamp } from './BookingStamp'
import { Document } from './Document'
import type { InvoiceItem } from './InvoiceItem'
import { Period } from './Period'
import type { Tax } from './Tax'
import type { TaxNumber } from './TaxNumber'
import type { VATIDNumber } from './VATIDNumber'

export class Invoice extends Document {
  issuer: Address = Address.createNullAddress()
  recipient: Address = Address.createNullAddress()
  taxNumber: TaxNumber | null = null
  vatIdNumber: VATIDNumber | null = null
  number: number | null = null
  periodOfService: Period = Period.createNullPeriod()
  date: Date | null = null
  dueTo: Date | null = null
  items: InvoiceItem[] = []
  subtotal: number = 0
  tax: Tax | null = null
  total: number = 0
  bookingStamp: BookingStamp | null = null
}
