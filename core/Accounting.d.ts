import type { Account } from './Account';
import type { Accountant } from './Accountant';
import { BookingRecord, BookingRecordElement } from './BookingRecord';
import type { IncomingInvoice } from './IncomingInvoice.js';
import type { Invoice } from './Invoice';
import { InvoiceItem } from './InvoiceItem.js';
import { Ledger } from './Ledger';
import { Payment } from './Payment';
export declare class Accounting {
    journal: BookingRecord[];
    ledger: Ledger;
    stampInvoice(invoice: Invoice, accountant: Accountant): void;
    bookIncomingInvoice(incomingInvoice: IncomingInvoice): void;
    bookPayingAnInvoice(incomingInvoice: IncomingInvoice, payments: Payment[]): void;
    _bookBookingRecords(bookingRecords: BookingRecord[]): void;
    _bookBookingRecord(bookingRecord: BookingRecord): void;
    _generateDescriptionFromBookingRecordElements(bookingRecordElements: BookingRecordElement[]): string;
    _generateDescriptionFromAccountNamesOfOtherSide(accounts: Account[]): string;
    _classifyIncomingInvoiceItemToAccount(invoiceItem: InvoiceItem): Account | null;
}
//# sourceMappingURL=Accounting.d.ts.map