import type { Account } from "./Account";
import type { Accountant } from "./Accountant";
import { AccountEntry } from './AccountEntry.js'
import { A } from './BookingRecord'
import { BookingRecord } from "./BookingRecord";
import { BookingStamp } from "./BookingStamp";
import type { IncomingInvoice } from './IncomingInvoice.js'
import type { Invoice } from "./Invoice";
import { InvoiceItem } from './InvoiceItem.js'

export class Accounting {
  journal: BookingRecord[] = []
  accounts: Map<string, Account> = new Map()

  addAccount(account: Account) {
    this.accounts.set(account.name, account)
  }

  stampInvoice(invoice: Invoice, accountant: Accountant) {
    invoice.bookingStamp = new BookingStamp(new Date(), accountant)
  }

  bookIncomingInvoice(incomingInvoice: IncomingInvoice) {
    const invoiceItem = incomingInvoice.items[0]
    const debitAccount = this._classifyIncomingInvoiceItemToAccount(invoiceItem)!
    const creditAccount = this.accounts.get('Liabilities')!

    this.journal.push(
      new BookingRecord(
        incomingInvoice.bookingStamp!.date,
        [
          new A(incomingInvoice, debitAccount, incomingInvoice.total)
        ],
        [
          new A(incomingInvoice, creditAccount, incomingInvoice.total)
        ],
      )
    )
    debitAccount.debit.push(new AccountEntry(creditAccount.name, incomingInvoice.total))
    creditAccount.credit.push(new AccountEntry(debitAccount.name, incomingInvoice.total))
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
      if (this.accounts.has(accountName)) {
        account = this.accounts.get(accountName)!
      } else {
        account = null
      }
    }

    return account
  }
}
