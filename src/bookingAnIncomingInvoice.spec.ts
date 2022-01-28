import { describe, expect, it } from '@jest/globals'
import { Account } from './Account.js'
import { Accountant } from './Accountant.js'
import { AccountEntry } from './AccountEntry.js'
import { Accounting } from './Accounting.js'
import { A, BookingRecord } from './BookingRecord.js'
import { IncomingInvoice } from './IncomingInvoice.js'
import { InvoiceItem } from './InvoiceItem.js'
import { Unit } from './Unit.js'

describe('booking an incoming invoice', () => {
  it('creates the booking records in the journal and the account entries on the accounts', () => {
    const incomingInvoice = new IncomingInvoice()
    const invoiceItem = new InvoiceItem()
    invoiceItem.description = 'Wood'
    invoiceItem.amountOfUnit = 10
    invoiceItem.unit = Unit.Kilogram
    invoiceItem.pricePerUnit = 10
    incomingInvoice.items.push(invoiceItem)
    incomingInvoice.total = incomingInvoice.items[0].amountOfUnit * incomingInvoice.items[0].pricePerUnit
    const rawMaterialsAccount = new Account(null, 'Raw materials')
    const liabilitiesAccount = new Account(null, 'Liabilities')
    const accounting = new Accounting()
    const accountant = new Accountant()
    accounting.addAccount(rawMaterialsAccount)
    accounting.addAccount(liabilitiesAccount)
    accounting.stampInvoice(incomingInvoice, accountant)
    accounting.bookIncomingInvoice(incomingInvoice)
    expect(accounting.journal).toEqual([
      new BookingRecord(
        incomingInvoice.bookingStamp!.date,
        [
          new A(incomingInvoice, rawMaterialsAccount, incomingInvoice.total)
        ],
        [
          new A(incomingInvoice, liabilitiesAccount, incomingInvoice.total)
        ],
      ),
    ])
    expect(rawMaterialsAccount.debit).toEqual([
      new AccountEntry(liabilitiesAccount.name, incomingInvoice.total),
    ])
    expect(liabilitiesAccount.credit).toEqual([
      new AccountEntry(rawMaterialsAccount.name, incomingInvoice.total),
    ])
  })

  it('creates the booking records in the journal and the account entries on the accounts (2)', () => {
    const incomingInvoice = new IncomingInvoice()
    const invoiceItem = new InvoiceItem()
    invoiceItem.description = 'Piece of paper'
    invoiceItem.amountOfUnit = 10
    invoiceItem.unit = Unit.Kilogram
    invoiceItem.pricePerUnit = 0.10
    incomingInvoice.items.push(invoiceItem)
    incomingInvoice.total = incomingInvoice.items[0].amountOfUnit * incomingInvoice.items[0].pricePerUnit
    const officeSuppliesAccount = new Account(null, 'Office supplies')
    const liabilitiesAccount = new Account(null, 'Liabilities')
    const accounting = new Accounting()
    const accountant = new Accountant()
    accounting.addAccount(officeSuppliesAccount)
    accounting.addAccount(liabilitiesAccount)
    accounting.stampInvoice(incomingInvoice, accountant)
    accounting.bookIncomingInvoice(incomingInvoice)
    expect(accounting.journal).toEqual([
      new BookingRecord(
        incomingInvoice.bookingStamp!.date,
        [
          new A(incomingInvoice, officeSuppliesAccount, incomingInvoice.total)
        ],
        [
          new A(incomingInvoice, liabilitiesAccount, incomingInvoice.total)
        ],
      ),
    ])
    expect(officeSuppliesAccount.debit).toEqual([
      new AccountEntry(liabilitiesAccount.name, incomingInvoice.total),
    ])
    expect(liabilitiesAccount.credit).toEqual([
      new AccountEntry(officeSuppliesAccount.name, incomingInvoice.total),
    ])
  })
})
