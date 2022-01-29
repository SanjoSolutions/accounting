import type { Account } from './Account'
import type { Accountant } from './Accountant'
import { AccountEntry } from './AccountEntry.js'
import { BookingRecord, BookingRecordElement } from './BookingRecord'
import { BookingStamp } from './BookingStamp'
import type { IncomingInvoice } from './IncomingInvoice.js'
import type { Invoice } from './Invoice'
import { InvoiceItem } from './InvoiceItem.js'
import { Ledger } from './Ledger'
import { Payment } from './Payment'

export class Accounting {
  journal: BookingRecord[] = []
  ledger: Ledger = new Ledger()

  stampInvoice(invoice: Invoice, accountant: Accountant) {
    invoice.bookingStamp = new BookingStamp(new Date(), accountant)
  }

  bookIncomingInvoice(incomingInvoice: IncomingInvoice) {
    const bookingRecords = []

    const invoiceItem = incomingInvoice.items[0]
    const debitAccount = this._classifyIncomingInvoiceItemToAccount(invoiceItem)!
    const creditAccount = this.ledger.accounts.get('Liabilities')!
    const bookingRecord = new BookingRecord(
      incomingInvoice.bookingStamp!.date,
      [
        new BookingRecordElement(incomingInvoice, debitAccount, incomingInvoice.total),
      ],
      [
        new BookingRecordElement(incomingInvoice, creditAccount, incomingInvoice.total),
      ],
    )
    bookingRecords.push(bookingRecord)

    this.journal.push(...bookingRecords)

    this._bookBookingRecords(bookingRecords)
  }

  bookPayingAnInvoice(incomingInvoice: IncomingInvoice, payments: Payment[]) {
    const bookingRecords = []

    const debitAccount = this.ledger.accounts.get('Liabilities')!
    const creditSide = []
    for (const { account, amount } of payments) {
      creditSide.push(new BookingRecordElement(incomingInvoice, account, amount))
    }
    const bookingRecord = new BookingRecord(
      incomingInvoice.bookingStamp!.date,
      [
        new BookingRecordElement(incomingInvoice, debitAccount, incomingInvoice.total),
      ],
      creditSide,
    )
    bookingRecords.push(bookingRecord)

    this.journal.push(...bookingRecords)

    this._bookBookingRecords(bookingRecords)
  }

  _bookBookingRecords(bookingRecords: BookingRecord[]) {
    bookingRecords.map(bookingRecord => this._bookBookingRecord(bookingRecord))
  }

  _bookBookingRecord(bookingRecord: BookingRecord) {
    for (const debitSideEntry of bookingRecord.debitSide) {
      const description = this._generateDescriptionFromBookingRecordElements(bookingRecord.creditSide)
      debitSideEntry.account.debit.push(new AccountEntry(description, debitSideEntry.amount))
    }

    for (const creditSideEntry of bookingRecord.creditSide) {
      const description = this._generateDescriptionFromBookingRecordElements(bookingRecord.debitSide)
      creditSideEntry.account.credit.push(new AccountEntry(description, creditSideEntry.amount))
    }
  }

  _generateDescriptionFromBookingRecordElements(bookingRecordElements: BookingRecordElement[]): string {
    return this._generateDescriptionFromAccountNamesOfOtherSide(bookingRecordElements.map(({ account }) => account))
  }

  _generateDescriptionFromAccountNamesOfOtherSide(accounts: Account[]): string {
    return accounts.map(account => account.name).join(' / ')
  }

  _classifyIncomingInvoiceItemToAccount(invoiceItem: InvoiceItem): Account | null {
    let account: Account | null
    const description = invoiceItem.description
    let accountName: string | null = null
    if (description === 'Wood') {
      accountName = 'Raw materials'
    } else if (description === 'Piece of paper') {
      accountName = 'Office supplies'
    }

    if (accountName === null) {
      account = null
    } else {
      if (this.ledger.accounts.has(accountName)) {
        account = this.ledger.accounts.get(accountName)!
      } else {
        account = null
      }
    }

    return account
  }
}
