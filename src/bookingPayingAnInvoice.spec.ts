import { describe, expect, it } from '@jest/globals'
import { Account } from './Account.js'
import { Accountant } from './Accountant.js'
import { AccountEntry } from './AccountEntry.js'
import { Accounting } from './Accounting.js'
import { A, BookingRecord } from './BookingRecord.js'
import { IncomingInvoice } from './IncomingInvoice.js'
import { InvoiceItem } from './InvoiceItem.js'
import { Unit } from './Unit.js'

describe.skip('booking paying an invoice', () => {
  it('creates the booking records in the journal and the account entries on the accounts', () => {
    const incomingInvoice = new IncomingInvoice()
    const invoiceItem = new InvoiceItem()
    invoiceItem.description = 'Piece of paper'
    invoiceItem.amountOfUnit = 10
    invoiceItem.unit = Unit.Kilogram
    invoiceItem.pricePerUnit = 0.10
    incomingInvoice.items.push(invoiceItem)
    incomingInvoice.total = incomingInvoice.items[0].amountOfUnit * incomingInvoice.items[0].pricePerUnit
    const liabilitiesAccount = new Account(null, 'Liabilities')
    const bank1Account = new Account(null, 'Bank 1')
    const bank2Account = new Account(null, 'Bank 2')
    const accounting = new Accounting()
    const accountant = new Accountant()
    accounting.addAccount(liabilitiesAccount)
    accounting.addAccount(bank1Account)
    accounting.addAccount(bank2Account)
    accounting.stampInvoice(incomingInvoice, accountant)
    accounting.bookIncomingInvoice(incomingInvoice)
    expect(accounting.journal).toEqual([
      new BookingRecord(
        incomingInvoice.bookingStamp!.date,
        [
          new A(incomingInvoice, liabilitiesAccount, incomingInvoice.total),
        ],
        [
          new A(incomingInvoice, bank1Account, 600),
          new A(incomingInvoice, bank2Account, 400),
        ],
      ),
    ])
    expect(liabilitiesAccount.debit).toEqual([
      new AccountEntry(`${ bank1Account.name } / ${ bank2Account }`, incomingInvoice.total),
    ])
    expect(bank1Account.credit).toEqual([
      new AccountEntry(liabilitiesAccount.name, 600),
    ])
    expect(bank2Account.credit).toEqual([
      new AccountEntry(liabilitiesAccount.name, 400),
    ])
  })
})
