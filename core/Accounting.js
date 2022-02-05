import { AccountEntry } from './AccountEntry.js';
import { BookingRecord, BookingRecordElement } from './BookingRecord';
import { BookingStamp } from './BookingStamp';
import { Ledger } from './Ledger';
export class Accounting {
    journal = [];
    ledger = new Ledger();
    stampInvoice(invoice, accountant) {
        invoice.bookingStamp = new BookingStamp(new Date(), accountant);
    }
    bookIncomingInvoice(incomingInvoice) {
        const bookingRecords = [];
        const invoiceItem = incomingInvoice.items[0];
        const debitAccount = this._classifyIncomingInvoiceItemToAccount(invoiceItem);
        const creditAccount = this.ledger.accounts.get('Liabilities');
        const bookingRecord = new BookingRecord(incomingInvoice.bookingStamp.date, [
            new BookingRecordElement(incomingInvoice, debitAccount, incomingInvoice.total),
        ], [
            new BookingRecordElement(incomingInvoice, creditAccount, incomingInvoice.total),
        ]);
        bookingRecords.push(bookingRecord);
        this.journal.push(...bookingRecords);
        this._bookBookingRecords(bookingRecords);
    }
    bookPayingAnInvoice(incomingInvoice, payments) {
        const bookingRecords = [];
        const debitAccount = this.ledger.accounts.get('Liabilities');
        const creditSide = [];
        for (const { account, amount } of payments) {
            creditSide.push(new BookingRecordElement(incomingInvoice, account, amount));
        }
        const bookingRecord = new BookingRecord(incomingInvoice.bookingStamp.date, [
            new BookingRecordElement(incomingInvoice, debitAccount, incomingInvoice.total),
        ], creditSide);
        bookingRecords.push(bookingRecord);
        this.journal.push(...bookingRecords);
        this._bookBookingRecords(bookingRecords);
    }
    _bookBookingRecords(bookingRecords) {
        bookingRecords.map(bookingRecord => this._bookBookingRecord(bookingRecord));
    }
    _bookBookingRecord(bookingRecord) {
        for (const debitSideEntry of bookingRecord.debitSide) {
            const description = this._generateDescriptionFromBookingRecordElements(bookingRecord.creditSide);
            debitSideEntry.account.debit.push(new AccountEntry(description, debitSideEntry.amount));
        }
        for (const creditSideEntry of bookingRecord.creditSide) {
            const description = this._generateDescriptionFromBookingRecordElements(bookingRecord.debitSide);
            creditSideEntry.account.credit.push(new AccountEntry(description, creditSideEntry.amount));
        }
    }
    _generateDescriptionFromBookingRecordElements(bookingRecordElements) {
        return this._generateDescriptionFromAccountNamesOfOtherSide(bookingRecordElements.map(({ account }) => account));
    }
    _generateDescriptionFromAccountNamesOfOtherSide(accounts) {
        return accounts.map(account => account.name).join(' / ');
    }
    _classifyIncomingInvoiceItemToAccount(invoiceItem) {
        let account;
        const description = invoiceItem.description;
        let accountName = null;
        if (description === 'Wood') {
            accountName = 'Raw materials';
        }
        else if (description === 'Piece of paper') {
            accountName = 'Office supplies';
        }
        if (accountName === null) {
            account = null;
        }
        else {
            if (this.ledger.accounts.has(accountName)) {
                account = this.ledger.accounts.get(accountName);
            }
            else {
                account = null;
            }
        }
        return account;
    }
}
//# sourceMappingURL=Accounting.js.map